# beeline09.github.io

Хаб community-прошивок beeline09 на GitHub Pages.

| URL | Содержимое |
|-----|------------|
| https://beeline09.github.io | Хаб проектов |
| https://beeline09.github.io/darktec/ | Flasher: роли, химия, имя ноды, радио, on-demand CI (`darktec-ondemand`) |

Это **не** официальный [meshcore.io/flasher](https://meshcore.io/flasher). Бинарники берутся из Releases форка [`beeline09/MeshCore`](https://github.com/beeline09/MeshCore/tree/south_edition) (ветка `south_edition`); сайт только статическая витрина.

Манифест на странице читается из **same-origin** `darktec/releases.json`
(обновляется Actions по schedule / `repository_dispatch`). Живой GitHub API —
только запасной one-shot fallback, не в цикле. Кастомные сборки используют
`darktec/firmware/ondemand/ondemand-manifest.json` + зеркала zip/uf2.

## Автосборка прошивок

В форке `beeline09/MeshCore` workflow **Build Darktec Firmwares**:

- триггер: push в `south_edition` (+ ручной dispatch)
- собирает матрицу: роль × химия × ячейки × защита (`adc` / `off`) — UF2 + OTA zip
- публикует/обновляет Release с тегом **`darktec-latest`**
- опционально шлёт `repository_dispatch` на этот сайт (секрет `PAGES_DISPATCH_TOKEN` в MeshCore)

## On-demand (имя ноды и радио)

Кастомное имя ноды или параметры радио → Release-кэш **`darktec-ondemand`** в MeshCore.

1. Страница `/darktec/` ищет ассет в same-origin зеркале `darktec/firmware/ondemand/`
   (`ondemand-manifest.json`), имя вида
   `Darktec_{role}_{chem}_{Ns}_{protect}__{name_slug}__{radio}__{sha8}.{uf2,zip}`.
2. При промахе открывается issue с меткой `darktec-ondemand` (или body `<!-- darktec-ondemand ... -->`).
3. Workflow **Build Darktec On-Demand** собирает один вариант и заливает в Release (`--clobber`),
   затем **Sync Darktec releases** зеркалит файлы на Pages.

## Быстрый старт

1. Создайте на GitHub публичный репозиторий **`beeline09/beeline09.github.io`** (имя должно совпадать с аккаунтом).
2. Запушьте эту ветку `main`:

```bash
git remote add origin https://github.com/beeline09/beeline09.github.io.git
git push -u origin main
```

3. Settings → Pages → Source: **Deploy from a branch** → `main` / `/ (root)`.
4. В [`beeline09/MeshCore`](https://github.com/beeline09/MeshCore/tree/south_edition) опубликуйте Release с ассетами вида:
   - `Darktec_companion_radio_ble_liion_1s_adc.uf2` (+ `.zip` для онлайн)
   - `Darktec_companion_radio_ble_liion_1s_off.uf2`
   - то же для `lifepo4` / `lto_1s` / `lto_2s` и остальных ролей
5. В этом репо: Actions → **Sync Darktec releases** → Run workflow  
   (или локально: `python3 scripts/generate-releases.py` / `node scripts/generate-releases.mjs`).

После синка `darktec/releases.json` заполнится ссылками на ассеты, и кнопка «Скачать UF2» на сайте заработает.

## Локальный просмотр

```bash
# из корня репозитория
python3 -m http.server 8080
# открыть http://127.0.0.1:8080/ и http://127.0.0.1:8080/darktec/
```

Абсолютные пути CSS (`/assets/...`) требуют сервер с корнем в этом репо, не `file://`.

## Архитектура MVP

```
beeline09.github.io/
  index.html                 # хаб
  assets/css/site.css
  darktec/                   # flasher + firmware mirrors
    index.html
    app.js
    ondemand.js
  scripts/generate-releases.mjs
  .github/workflows/sync-releases.yml
```

Имена UF2 / OTA zip:

`Darktec_{role}_{liion|lifepo4|lto}_{1|2}s_{adc|off}.{uf2,zip}`

- `adc` — sleep/wake по АЦП (защита от глубокой разрядки)
- `off` — без автоотключения по низкому заряду

## Связь с MeshCore (опционально)

Чтобы сайт обновлялся сразу после релиза прошивки, из workflow в `MeshCore` можно вызвать:

```yaml
- uses: peter-evans/repository-dispatch@v3
  with:
    token: ${{ secrets.PAGES_DISPATCH_TOKEN }}
    repository: beeline09/beeline09.github.io
    event-type: meshcore-release
```

Токен — PAT с `contents: write` на Pages-репо (у `GITHUB_TOKEN` чужого репо нет прав).

## Дальше (не в этом MVP)

- Фаза 2: форк фронта flasher.meshcore.io + Web Serial DFU, когда появятся OTA zip / erase firmware.
- Фаза 3: другие проекты как `/имя` на этом же хабе; свой домен через CNAME.
