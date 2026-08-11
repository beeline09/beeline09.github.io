/**
 * Vendored from https://github.com/meshcore-dev/flasher.meshcore.io (MIT)
 * Original: lib/console.js — SerialConsole for MeshCore USB CLI @ 115200.
 *
 * MIT License
 * Copyright (c) 2025 Rastislav Vysoky
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

function delay(msecs) {
  return new Promise((resolve) => setTimeout(resolve, msecs));
}

class LineBreakTransformer {
  chunks = '';
  port = null;

  transform(chunk, controller) {
    // Append new chunks to existing chunks.
    this.chunks += chunk;
    // For each line breaks in chunks, send the parsed lines out.
    const lines = this.chunks.split('\r\n');
    this.chunks = lines.pop();
    lines.forEach((line) => controller.enqueue(line + '\r\n'));
  }

  flush(controller) {
    // When the stream is closed, flush any remaining chunks out.
    controller.enqueue(this.chunks);
  }
}

export class SerialConsole {
  connected = false;
  constructor(port) {
    this.port = port;
    this.controller = new AbortController();
    this.signal = this.controller.signal;
    this.onOutput = (text) => {
      console.log(text);
    };
  }

  async connect() {
    try {
      await this.port.open({ baudRate: 115200 });
      this.connected = true;
      await this.port.readable
        .pipeThrough(new TextDecoderStream(), { signal: this.signal })
        .pipeThrough(new TransformStream(new LineBreakTransformer()))
        .pipeTo(
          new WritableStream({
            write: (chunk) => {
              this.addLine(chunk.replace('\r', ''));
            },
          }),
        );

        // Check AFTER the pipeTo has completed (or been aborted)
      if (!this.signal.aborted) {
        this.addLine('\n\n*** Terminal disconnected');
        this.connected = false;
      }
    } catch (e) {
      this.addLine(`\n\n*** Terminal disconnected: ${e}`);
      this.connected = false;
    } finally {
      await delay(100);
    }
  }

  addLine(text) {
    this.onOutput(text);
  }

  async sendCommand(command) {
    const encoder = new TextEncoder();
    const writer = this.port.writable.getWriter(); // Get writer from 'this.port'
    await writer.write(encoder.encode(command + '\r\n'));
    try {
      writer.releaseLock();
    } catch (err) {
      console.error('Ignoring release lock error', err);
    }
  }

  async disconnect() {
    this.controller.abort();
    await delay(50);
    await this.port.close();
  }

  async reset() {
    console.debug('Triggering reset');
    await this.port.setSignals({
      dataTerminalReady: false,
      requestToSend: true,
    });
    await delay(250);
    await this.port.setSignals({
      dataTerminalReady: false,
      requestToSend: false,
    });

    await delay(1250);
  }
}