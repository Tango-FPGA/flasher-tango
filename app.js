/* Modified from bflb_flash_web (bouffalo_sdk tools/bflb_flash_web, Apache-2.0): see NOTICE. */
(function () {
  "use strict";

  const { concatBytes, bytesToHex, formatErrorCode } = window.BflbFlashProtocol;
  const { BflbFlasher, BAUD_RATE } = window.BflbFlasher;
  const { TangoSession, FIRMWARE_ADDRESS, SIPEED_DEBUGGER, TANGO_RELEASES, fetchSipeedDebugger, fetchLatestFirmware, compareWithLatest, formatBytes, hex } =
    window.TangoImage;

  /* USB IDs of the BL616 boot ROM's CDC serial port (update mode). */
  const UPDATE_MODE_PORT = Object.freeze({ usbVendorId: 0x349b, usbProductId: 0x6160 });

  const elements = {
    supportNotice: document.querySelector("#support-notice"),
    connectButton: document.querySelector("#connect-button"),
    disconnectButton: document.querySelector("#disconnect-button"),
    sipeedGet: document.querySelector("#sipeed-get"),
    sipeedButton: document.querySelector("#sipeed-button"),
    chooseYourself: document.querySelector("#choose-yourself"),
    sipeedFailed: document.querySelector("#sipeed-failed"),
    debuggerReplace: document.querySelector("#debugger-replace"),
    replaceDebugger: document.querySelector("#replace-debugger"),
    sipeedFailedDetail: document.querySelector("#sipeed-failed-detail"),
    debuggerPicker: document.querySelector("#debugger-picker"),
    debuggerInput: document.querySelector("#debugger-file"),
    debuggerZone: document.querySelector("#debugger-zone"),
    debuggerName: document.querySelector("#debugger-name"),
    debuggerMeta: document.querySelector("#debugger-meta"),
    debuggerMessages: document.querySelector("#debugger-messages"),
    ackRow: document.querySelector("#ack-row"),
    ackUnknown: document.querySelector("#ack-unknown"),
    githubGet: document.querySelector("#github-get"),
    githubButton: document.querySelector("#github-button"),
    chooseFirmwareYourself: document.querySelector("#choose-firmware-yourself"),
    githubFailed: document.querySelector("#github-failed"),
    githubFailedDetail: document.querySelector("#github-failed-detail"),
    githubDirectLink: document.querySelector("#github-direct-link"),
    firmwareReplace: document.querySelector("#firmware-replace"),
    replaceFirmware: document.querySelector("#replace-firmware"),
    firmwareNotes: document.querySelector("#firmware-notes"),
    firmwarePicker: document.querySelector("#firmware-picker"),
    firmwareInput: document.querySelector("#firmware-file"),
    firmwareZone: document.querySelector("#firmware-zone"),
    firmwareName: document.querySelector("#firmware-name"),
    firmwareMeta: document.querySelector("#firmware-meta"),
    firmwareMessages: document.querySelector("#firmware-messages"),
    plan: document.querySelector("#plan"),
    autoReset: document.querySelector("#auto-reset"),
    runAfterFlash: document.querySelector("#run-after-flash"),
    showAllPorts: document.querySelector("#show-all-ports"),
    flashButton: document.querySelector("#flash-button"),
    cancelButton: document.querySelector("#cancel-button"),
    notReady: document.querySelector("#not-ready"),
    statusDot: document.querySelector("#status-dot"),
    statusText: document.querySelector("#status-text"),
    stageText: document.querySelector("#stage-text"),
    progressBar: document.querySelector("#progress-bar"),
    progressValue: document.querySelector("#progress-value"),
    log: document.querySelector("#log"),
    clearLogButton: document.querySelector("#clear-log"),
  };

  let port = null;
  let transport = null;
  let flashing = false;
  let cancelled = false;
  let loading = 0;
  let latestRelease = null;
  const session = new TangoSession();

  class SerialTransport {
    constructor(serialPort) {
      this.port = serialPort;
      this.reader = null;
      this.writer = null;
      this.buffer = new Uint8Array();
      this.waiters = new Set();
      this.readError = null;
      this.closed = false;
    }

    async open() {
      await this.port.open({
        baudRate: BAUD_RATE,
        dataBits: 8,
        stopBits: 1,
        parity: "none",
        flowControl: "none",
        bufferSize: 32768,
      });
      this.reader = this.port.readable.getReader();
      this.writer = this.port.writable.getWriter();
      this.baudRate = BAUD_RATE;
      this.closed = false;
      this.readLoop = this.pump();
    }

    async pump() {
      try {
        while (!this.closed) {
          const { value, done } = await this.reader.read();
          if (done) break;
          if (value && value.length) {
            this.buffer = concatBytes(this.buffer, value);
            this.wakeWaiters();
          }
        }
      } catch (error) {
        if (!this.closed) this.readError = error;
      } finally {
        this.wakeWaiters();
      }
    }

    wakeWaiters() {
      for (const resolve of this.waiters) resolve();
      this.waiters.clear();
    }

    async waitForData(timeoutMs) {
      if (this.readError) throw this.readError;
      return new Promise((resolve, reject) => {
        let timer;
        const wake = () => {
          clearTimeout(timer);
          this.waiters.delete(wake);
          resolve();
        };
        timer = setTimeout(() => {
          this.waiters.delete(wake);
          reject(new Error("Timed out waiting for the board"));
        }, timeoutMs);
        this.waiters.add(wake);
      });
    }

    async readExactly(length, timeoutMs = 3000) {
      const deadline = performance.now() + timeoutMs;
      while (this.buffer.length < length) {
        const remaining = deadline - performance.now();
        if (remaining <= 0) throw new Error("Timed out waiting for the board");
        await this.waitForData(remaining);
      }
      const result = this.buffer.slice(0, length);
      this.buffer = this.buffer.slice(length);
      return result;
    }

    async readUntil(sequence, timeoutMs = 3000) {
      const deadline = performance.now() + timeoutMs;
      while (true) {
        const index = findSequence(this.buffer, sequence);
        if (index >= 0) {
          const result = this.buffer.slice(0, index + sequence.length);
          this.buffer = this.buffer.slice(index + sequence.length);
          return result;
        }
        const remaining = deadline - performance.now();
        if (remaining <= 0) throw new Error("Timed out waiting for the board to answer");
        await this.waitForData(remaining);
      }
    }

    async write(bytes) {
      await this.writer.write(bytes);
    }

    async setSignals(signals) {
      await this.port.setSignals(signals);
    }

    async releaseStreams() {
      let cleanupError = null;
      if (this.reader) {
        const reader = this.reader;
        try {
          await reader.cancel();
          if (this.readLoop) await this.readLoop;
        } catch (_) {
          // Still try to release the lock so writer cleanup is not skipped.
        }
        try {
          reader.releaseLock();
          this.reader = null;
        } catch (error) {
          cleanupError = error;
        }
      }
      if (this.writer) {
        try {
          this.writer.releaseLock();
          this.writer = null;
        } catch (error) {
          cleanupError ||= error;
        }
      }
      if (!this.reader) this.readLoop = null;
      if (cleanupError) throw cleanupError;
    }

    clearInput() {
      this.buffer = new Uint8Array();
    }

    async readAck(timeoutMs = 3000) {
      const ack = await this.readExactly(2, timeoutMs);
      const text = String.fromCharCode(ack[0], ack[1]);
      if (text === "OK" || text === "PD") return { status: text };
      if (text === "FL") {
        const errorBytes = await this.readExactly(2, timeoutMs);
        const code = errorBytes[0] | (errorBytes[1] << 8);
        throw new Error(`The board reported error ${formatErrorCode(code)}`);
      }
      throw new Error(`Unexpected reply from the board 0x${bytesToHex(ack)}`);
    }

    async readResponse(timeoutMs = 3000) {
      const ack = await this.readAck(timeoutMs);
      if (ack.status !== "OK") throw new Error(`Unexpected reply from the board: ${ack.status}`);
      const lengthBytes = await this.readExactly(2, timeoutMs);
      const length = lengthBytes[0] | (lengthBytes[1] << 8);
      return this.readExactly(length, timeoutMs);
    }

    async close() {
      this.closed = true;
      this.wakeWaiters();
      await this.releaseStreams();
      if (this.port.readable?.locked || this.port.writable?.locked) {
        throw new Error("The serial port streams are still locked");
      }
      if (this.port.readable || this.port.writable) await this.port.close();
    }
  }

  function findSequence(haystack, needle) {
    outer: for (let index = 0; index <= haystack.length - needle.length; index += 1) {
      for (let inner = 0; inner < needle.length; inner += 1) {
        if (haystack[index + inner] !== needle[inner]) continue outer;
      }
      return index;
    }
    return -1;
  }

  function formatSize(size) {
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`;
    return `${(size / 1024 / 1024).toFixed(2)} MiB`;
  }

  function log(message, level = "info") {
    const row = document.createElement("div");
    row.className = `log-row log-${level}`;
    const time = new Date().toLocaleTimeString("en-GB", { hour12: false });
    row.textContent = `${time}  ${message}`;
    elements.log.append(row);
    elements.log.scrollTop = elements.log.scrollHeight;
  }

  function setStatus(kind, text) {
    elements.statusDot.dataset.status = kind;
    elements.statusText.textContent = text;
  }

  function setProgress(value, stage) {
    const normalized = Math.max(0, Math.min(100, value));
    elements.progressBar.value = normalized;
    elements.progressValue.textContent = `${Math.round(normalized)}%`;
    if (stage) elements.stageText.textContent = stage;
  }

  function showMessages(list, check) {
    list.replaceChildren();
    if (!check) return;
    const add = (text, kind) => {
      const item = document.createElement("li");
      item.className = `msg-${kind}`;
      item.textContent = text;
      list.append(item);
    };
    for (const text of check.errors) add(text, "error");
    for (const text of check.warnings) add(text, "warn");
    if (check.ok && check.okText) add(check.okText, "ok");
  }

  function renderFiles() {
    const d = session.debugger;
    const f = session.firmware;
    if (d) {
      if (d.source === "sipeed") {
        d.check.okText = `${d.check.known.name} \u2014 downloaded from Sipeed`;
      } else {
        d.check.okText = d.check.known ? `${d.check.known.name}. Tested with Tango.` : "";
        elements.debuggerName.textContent = d.name || "Sipeed debugger file";
        elements.debuggerMeta.textContent = `${formatBytes(d.bytes.length)} · SHA-256 ${d.check.sha256}`;
      }
      elements.debuggerZone.classList.toggle("has-file", d.source === "file" && d.check.ok);
      elements.debuggerZone.classList.toggle("bad-file", d.source === "file" && !d.check.ok);
      elements.ackRow.hidden = !(d.check.ok && d.check.needsAcknowledge);
    } else {
      elements.ackRow.hidden = true;
      elements.debuggerName.textContent = "Click to choose, or drop the file here";
      elements.debuggerMeta.textContent = "bl616_fpga_partner_Console.bin, 110,992 bytes";
      elements.debuggerZone.classList.remove("has-file");
      elements.debuggerZone.classList.remove("bad-file");
    }
    debuggerBox.render(d);
    elements.ackUnknown.checked = session.acknowledged;
    showMessages(elements.debuggerMessages, d && d.check);
    if (f) {
      const what = f.check.version ? `Tango firmware, ${f.check.version.display}` : "Tango firmware (version not found in the file)";
      if (f.source === "github") {
        f.check.okText = `${what} \u2014 the latest release, downloaded from GitHub`;
        elements.firmwareNotes.href = f.release.notesUrl;
      } else {
        f.check.okText = `${what}.`;
        elements.firmwareName.textContent = f.name || "Tango firmware file";
        elements.firmwareMeta.textContent = `${formatBytes(f.bytes.length)} · SHA-256 ${f.check.sha256}`;
      }
      elements.firmwareZone.classList.toggle("has-file", f.source === "file" && f.check.ok);
      elements.firmwareZone.classList.toggle("bad-file", f.source === "file" && !f.check.ok);
    } else {
      elements.firmwareName.textContent = "Click to choose, or drop the file here";
      elements.firmwareMeta.textContent = "firmware-tango_<date>.bin";
      elements.firmwareZone.classList.remove("has-file");
      elements.firmwareZone.classList.remove("bad-file");
    }
    elements.firmwareNotes.hidden = !(f && f.source === "github");
    firmwareBox.render(f);
    showMessages(elements.firmwareMessages, f && f.check);
    const comparison = f && f.source === "file" ? compareWithLatest(f.check, latestRelease) : null;
    if (comparison) {
      const item = document.createElement("li");
      item.className = comparison.kind === "latest" ? "msg-ok" : "msg-info";
      item.textContent = comparison.text;
      elements.firmwareMessages.append(item);
    }

    if (d && d.check.ok && f && f.check.ok) {
      const total = FIRMWARE_ADDRESS + f.bytes.length;
      elements.plan.textContent =
        `The installer will erase the BL616 flash from 0x0 to ${hex(total - 1)} and write one ${formatBytes(total)} image there: ` +
        `the debugger file at 0x0, empty space (0xFF) from ${hex(d.bytes.length)} to ${hex(FIRMWARE_ADDRESS - 1)}, ` +
        `and the Tango firmware at ${hex(FIRMWARE_ADDRESS)}. It then reads the whole range back to check it.`;
      elements.plan.hidden = false;
    } else {
      elements.plan.hidden = true;
    }
  }

  function updateControls() {
    const connected = Boolean(transport);
    const usable = connected && !transport.closed;
    const state = session.readiness(usable);
    elements.connectButton.disabled = connected || flashing;
    elements.disconnectButton.disabled = !connected || flashing;
    debuggerBox.updateControls();
    firmwareBox.updateControls();
    elements.ackUnknown.disabled = flashing;
    elements.flashButton.disabled = !state.ready || flashing || loading > 0;
    elements.cancelButton.hidden = !flashing;
    elements.notReady.replaceChildren();
    if (!flashing) {
      for (const reason of state.reasons) {
        const item = document.createElement("li");
        item.textContent = reason;
        elements.notReady.append(item);
      }
    }
  }

  /*
   * A file box with a "get it for me" download, a "choose the file yourself instead" picker, a failure panel
   * and "replace this file". Every new attempt (download, pick, replace) first empties the box; only the
   * latest attempt may fill it.
   */
  function makeFileBox(config) {
    const el = config.elements;
    const box = { attempt: 0, fetching: false };

    box.begin = () => {
      box.attempt += 1;
      config.clear();
      el.failed.hidden = true;
      renderFiles();
      updateControls();
      return box.attempt;
    };

    box.revealPicker = () => {
      el.picker.hidden = false;
      el.chooseYourself.hidden = true;
    };

    box.replace = () => {
      if (flashing) return;
      box.begin();
      el.input.value = "";
      el.picker.hidden = true;
      el.chooseYourself.hidden = false;
      log(`${config.name} emptied: get the file again, or choose one yourself`);
    };

    box.fail = (detail) => {
      el.failedDetail.textContent = detail;
      el.failed.hidden = false;
      box.revealPicker();
      log(`${config.name}: ${config.failureLog}: ${detail}`, "error");
    };

    box.download = async () => {
      if (box.fetching || flashing) return;
      box.fetching = true;
      const attempt = box.begin();
      el.button.textContent = config.busyLabel;
      updateControls();
      try {
        const result = await config.download();
        if (attempt !== box.attempt) return;
        if (!result.ok) {
          if (config.onFailure) config.onFailure(result);
          box.fail(result.detail);
          return;
        }
        await config.accept(result);
        setProgress(0, "Files checked");
      } catch (error) {
        if (attempt !== box.attempt) return;
        box.fail(error.message);
      } finally {
        box.fetching = false;
        el.button.textContent = config.label;
        renderFiles();
        updateControls();
      }
    };

    box.render = (entry) => {
      const holdsGoodFile = Boolean(entry && entry.check.ok);
      el.replaceRow.hidden = !holdsGoodFile;
      el.get.hidden = holdsGoodFile;
      if (holdsGoodFile) {
        el.picker.hidden = true;
        el.failed.hidden = true;
      }
    };

    box.updateControls = () => {
      el.button.disabled = flashing || box.fetching;
      el.chooseYourself.disabled = flashing;
      el.replaceButton.disabled = flashing;
      el.input.disabled = flashing;
    };

    el.button.addEventListener("click", box.download);
    el.chooseYourself.addEventListener("click", box.revealPicker);
    el.replaceButton.addEventListener("click", box.replace);
    return box;
  }

  const fetchImpl = (url, init) => window.fetch(url, init);

  const debuggerBox = makeFileBox({
    name: "Box 1",
    label: "Get it from Sipeed for me",
    busyLabel: "Getting the file from Sipeed\u2026",
    failureLog: "could not get the file from Sipeed",
    elements: {
      get: elements.sipeedGet,
      button: elements.sipeedButton,
      chooseYourself: elements.chooseYourself,
      replaceRow: elements.debuggerReplace,
      replaceButton: elements.replaceDebugger,
      failed: elements.sipeedFailed,
      failedDetail: elements.sipeedFailedDetail,
      picker: elements.debuggerPicker,
      input: elements.debuggerInput,
    },
    clear: () => session.clearDebugger(),
    download: () => {
      log(`Downloading ${SIPEED_DEBUGGER.url}`);
      return fetchSipeedDebugger({ fetchImpl });
    },
    accept: async (result) => {
      await session.setDebugger(result.bytes, SIPEED_DEBUGGER.name, "sipeed");
      log(`Box 1: ${SIPEED_DEBUGGER.name}, downloaded from Sipeed, ${result.bytes.length} bytes, SHA-256 ${result.check.sha256}`, "success");
    },
  });

  const firmwareBox = makeFileBox({
    name: "Box 2",
    label: "Get it from GitHub for me",
    busyLabel: "Getting the firmware from GitHub\u2026",
    failureLog: "could not get the firmware from GitHub",
    elements: {
      get: elements.githubGet,
      button: elements.githubButton,
      chooseYourself: elements.chooseFirmwareYourself,
      replaceRow: elements.firmwareReplace,
      replaceButton: elements.replaceFirmware,
      failed: elements.githubFailed,
      failedDetail: elements.githubFailedDetail,
      picker: elements.firmwarePicker,
      input: elements.firmwareInput,
    },
    clear: () => session.clearFirmware(),
    download: () => {
      log(`Asking GitHub for the latest Tango firmware release (${TANGO_RELEASES.apiUrl})`);
      return fetchLatestFirmware({ fetchImpl });
    },
    onFailure: (result) => {
      if (result.release) {
        latestRelease = result.release;
        elements.githubDirectLink.href = result.release.downloadUrl;
        elements.githubDirectLink.textContent = `Download ${result.release.assetName} (release ${result.release.tag}) from GitHub`;
      } else {
        elements.githubDirectLink.href = TANGO_RELEASES.pageUrl;
        elements.githubDirectLink.textContent = "Open the Tango firmware releases page";
      }
    },
    accept: async (result) => {
      latestRelease = result.release;
      await session.setFirmware(result.bytes, result.release.assetName, "github", result.release);
      log(`Box 2: Tango firmware release ${result.release.tag}, downloaded from GitHub, ${result.bytes.length} bytes, SHA-256 ${result.check.sha256}`, "success");
    },
  });

  async function chooseFile(kind, file) {
    if (!file) return;
    const box = kind === "debugger" ? debuggerBox : firmwareBox;
    const attempt = box.begin();
    loading += 1;
    updateControls();
    try {
      const data = new Uint8Array(await file.arrayBuffer());
      if (attempt !== box.attempt) return;
      const check = kind === "debugger" ? await session.setDebugger(data, file.name) : await session.setFirmware(data, file.name);
      log(`${kind === "debugger" ? "Box 1" : "Box 2"}: ${file.name}, ${data.length} bytes, SHA-256 ${check.sha256}`);
      if (check.known) log(`Box 1 holds the ${check.known.name}`, "success");
      if (check.version) log(`Box 2 holds Tango firmware ${check.version.display}; the board will show "${check.version.aboutText}"`);
      for (const text of check.errors) log(text, "error");
      for (const text of check.warnings) log(text, "warn");
      setProgress(0, "Files checked");
    } finally {
      loading -= 1;
      renderFiles();
      updateControls();
    }
  }

  async function connect() {
    if (!navigator.serial) return;
    try {
      const options = elements.showAllPorts.checked ? {} : { filters: [UPDATE_MODE_PORT] };
      port = await navigator.serial.requestPort(options);
      transport = new SerialTransport(port);
      await transport.open();
      setStatus("connected", "Connected");
      log("Connected to the serial port");
    } catch (error) {
      transport = null;
      port = null;
      if (error.name !== "NotFoundError") {
        setStatus("error", "Could not connect");
        log(error.message, "error");
      } else if (!elements.showAllPorts.checked) {
        log("No board was chosen. If the list was empty, the board is not in update mode (see step 2).", "warn");
      }
    }
    updateControls();
  }

  async function disconnect() {
    if (!transport) return;
    const current = transport;
    try {
      await current.close();
      transport = null;
      port = null;
      setStatus("idle", "Not connected");
      log("Disconnected");
    } catch (error) {
      log(`Could not close the serial port: ${error.message}`, "error");
      setStatus("error", "Disconnect failed, try again");
    }
    updateControls();
  }

  const STAGE_NAMES = {
    handshake: "Talking to the board",
    "boot-info": "Reading the chip information",
    "flash-config": "Setting up the flash",
    erase: "Erasing the flash",
    verify: "Checking what was written",
    hash: "Computing the SHA-256",
    done: "Finished",
  };

  function handleFlashProgress(value, stage, detail) {
    if (stage === "write" && detail) {
      setProgress(value, `Writing ${formatSize(detail.written)} of ${formatSize(detail.total)}`);
      return;
    }
    setProgress(value, STAGE_NAMES[stage] || stage);
  }

  async function flash() {
    if (!transport || flashing) return;
    let image;
    try {
      image = session.image();
    } catch (error) {
      log(error.message, "error");
      return;
    }
    flashing = true;
    cancelled = false;
    updateControls();
    setStatus("working", "Installing");
    setProgress(1, STAGE_NAMES.handshake);
    log(`Writing ${image.length} bytes: the Sipeed debugger, then the Tango firmware`);
    try {
      const flasher = new BflbFlasher(transport, {
        onLog: (message, level) => log(message, level),
        onProgress: handleFlashProgress,
        isCancelled: () => cancelled,
      });
      const result = await flasher.flashWhole(image, {
        chip: "bl616",
        autoReset: elements.autoReset.checked,
        runAfterFlash: elements.runAfterFlash.checked,
      });
      const seconds = (result.elapsedMs / 1000).toFixed(1);
      setStatus("success", `Installed · ${seconds} s`);
      elements.stageText.textContent = "Done. Unplug the USB cable. Put in the microSD card and power the board from its FPGA USB-C port, with nothing on the MCU port: the Tango launcher starts.";
      log(`Written and checked in ${seconds} seconds. SHA-256 of the whole image: ${bytesToHex(result.sha256)}`, "success");
      log("Unplug the USB cable. Put in the microSD card and power the board from its FPGA USB-C port, with nothing on the MCU port: the Tango launcher starts. Connected to a computer on the MCU port, the board shows up as its USB debugger again.", "success");
    } catch (error) {
      const wasCancelled = error.name === "AbortError";
      setStatus(wasCancelled ? "idle" : "error", wasCancelled ? "Stopped" : "Install failed");
      elements.stageText.textContent = wasCancelled ? "Stopped. The board's flash may be incomplete: install again before using it." : error.message;
      log(error.message, wasCancelled ? "warn" : "error");
    } finally {
      flashing = false;
      cancelled = false;
      elements.cancelButton.disabled = false;
      updateControls();
    }
  }

  function wireDropZone(zone, input, kind) {
    input.addEventListener("change", async () => {
      try {
        await chooseFile(kind, input.files[0]);
      } catch (error) {
        log(error.message, "error");
      }
    });
    zone.addEventListener("dragover", (event) => {
      event.preventDefault();
      zone.classList.add("dragging");
    });
    zone.addEventListener("dragleave", () => zone.classList.remove("dragging"));
    zone.addEventListener("drop", async (event) => {
      event.preventDefault();
      zone.classList.remove("dragging");
      if (flashing) return;
      try {
        await chooseFile(kind, event.dataTransfer.files[0]);
      } catch (error) {
        log(error.message, "error");
      }
    });
  }

  function initialize() {
    if (!navigator.serial) {
      elements.supportNotice.hidden = false;
      elements.connectButton.disabled = true;
      setStatus("error", "This browser cannot use USB serial");
    }

    elements.connectButton.addEventListener("click", connect);
    elements.disconnectButton.addEventListener("click", disconnect);
    elements.flashButton.addEventListener("click", flash);
    elements.cancelButton.addEventListener("click", () => {
      cancelled = true;
      elements.cancelButton.disabled = true;
      elements.stageText.textContent = "Stopping";
    });
    elements.clearLogButton.addEventListener("click", () => elements.log.replaceChildren());
    elements.ackUnknown.addEventListener("change", () => {
      session.setAcknowledged(elements.ackUnknown.checked);
      updateControls();
    });
    wireDropZone(elements.debuggerZone, elements.debuggerInput, "debugger");
    wireDropZone(elements.firmwareZone, elements.firmwareInput, "firmware");
    navigator.serial?.addEventListener("disconnect", (event) => {
      if (event.target === port) {
        transport = null;
        port = null;
        setStatus("error", "Board disconnected");
        log("The board was disconnected", "error");
        updateControls();
      }
    });
    renderFiles();
    updateControls();
  }

  initialize();
})();
