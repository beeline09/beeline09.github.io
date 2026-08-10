# beeline09.github.io

Хаб community-прошивок beeline09 на GitHub Pages.

| URL | Содержимое |
|-----|------------|
| https://beeline09.github.io | Хаб проектов |
| https://beeline09.github.io/darktec/ | MVP: выбор роли/химии → скачать UF2 + инструкция DFU |

Это **не** официальный [meshcore.io/flasher](https://meshcore.io/flasher). Бинарники берутся из Releases форка [`beeline09/MeshCore`](https://github.com/beeline09/MeshCore); сайт только статическая витрина.

Манифест на странице сначала читается **напрямую из GitHub Releases API**
(`darktec-latest`), запасной вариант — статический `darktec/releases.json`
(обновляется Actions по schedule / `repository_dispatch`).

## Автосборка прошивок

В форке `beeline09/MeshCore` workflow **Build Darktec Firmwares**:

- триггер: push в `south_edition` или `southedition-origin` (+ ручной dispatch)
- собирает 8 UF2 (companion/repeater × химия)
- публикует/обновляет Release с тегом **`darktec-latest`**
- опционально шлёт `repository_dispatch` на этот сайт (секрет `PAGES_DISPATCH_TOKEN` в MeshCore)

## Быстрый старт

1. Создайте на GitHub публичный репозиторий **`beeline09/beeline09.github.io`** (имя должно совпадать с аккаунтом).
2. Запушьте эту ветку `main`:

```bash
git remote add origin https://github.com/beeline09/beeline09.github.io.git
git push -u origin main
```

3. Settings → Pages → Source: **Deploy from a branch** → `main` / `/ (root)`.
4. В [`beeline09/MeshCore`](https://github.com/beeline09/MeshCore) опубликуйте Release с ассетами вида:
   - `Darktec_companion_radio_ble_liion_1s.uf2`
   - `Darktec_companion_radio_ble_lifepo4_1s.uf2`
   - `Darktec_companion_radio_ble_lto_1s.uf2` / `_lto_2s.uf2`
   - `Darktec_repeater_liion_1s.uf2` (и остальные химии)
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
  darktec/
    index.html               # UI выбора
    app.js                   # матчинг роль × химия → файл
    releases.json            # статический манифест (вместо /releases бэкенда)
  scripts/generate-releases.mjs
  .github/workflows/sync-releases.yml
```

Имена UF2 должны совпадать с шаблоном из сборки Darktec:

`Darktec_{companion_radio_ble|repeater}_{liion|lifepo4|lto}_{1|2}s.uf2`

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
