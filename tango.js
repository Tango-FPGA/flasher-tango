/* SPDX-License-Identifier: Apache-2.0 */
/*
 * Tango install image: file checks and the join of the Sipeed debugger image (flash 0x0) with the
 * Tango firmware image (flash 0x40000) into one image written at 0x0. No external dependencies;
 * works in browsers and in Node.js.
 */
(function (root, factory) {
  "use strict";
  const api = factory();
  root.TangoImage = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : window, function () {
  "use strict";

  const FIRMWARE_ADDRESS = 0x40000;
  const BOOT_HEADER_SIZE = 0x100;
  const BOOT_MAGIC = "BFNP";
  const FIRMWARE_MARKER = "Tango FPGA v";
  const FIRMWARE_ID_PATTERN = /^(g(?:[0-9a-f]{7}|nogit)(?:-dirty)?) (\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01]) ([01]\d:[0-5]\d|2[0-3]:[0-5]\d)$/;

  /* Debugger (FPGA Partner) builds that have been tested at 0x0 under the Tango firmware. */
  const KNOWN_DEBUGGER_BUILDS = Object.freeze([
    Object.freeze({
      sha256: "38e45f62965548c3e0efbf1048f48d28f45bb06b746a589ccba0ce7c801d6190",
      size: 110992,
      name: "Sipeed Tang Console debugger, build 2025041420",
      fileName: "bl616_fpga_partner_Console.bin",
    }),
  ]);

  /* The pinned debugger build on Sipeed's download server; "Get it from Sipeed for me" fetches exactly this. */
  const SIPEED_DEBUGGER = Object.freeze({
    url: "https://api.dl.sipeed.com/TANG/Debugger/onboard/BL616/2025041420/bl616_fpga_partner_Console.bin",
    pageUrl: "https://en.wiki.sipeed.com/hardware/en/tang/common-doc/update_debugger.html",
    sha256: KNOWN_DEBUGGER_BUILDS[0].sha256,
    size: KNOWN_DEBUGGER_BUILDS[0].size,
    name: KNOWN_DEBUGGER_BUILDS[0].name,
    timeoutMs: 20000,
  });

  /* The Tango firmware releases on GitHub; the page asks for the latest release's metadata only. */
  const TANGO_RELEASES = Object.freeze({
    apiUrl: "https://api.github.com/repos/Tango-FPGA/firmware-tango/releases/latest",
    pageUrl: "https://github.com/Tango-FPGA/firmware-tango/releases",
    tagUrlPrefix: "https://github.com/Tango-FPGA/firmware-tango/releases/tag/",
    downloadUrlPrefix: "https://github.com/Tango-FPGA/firmware-tango/releases/download/",
    assetNameTemplate: "firmware-tango_{tag}.bin",
    timeoutMs: 10000,
    maxResponseChars: 1024 * 1024,
    downloadTimeoutMs: 20000,
    maxDownloadBytes: 4 * 1024 * 1024,
  });

  /* Where "Get it from GitHub for me" reads the firmware bytes; {tag} is the release tag (YYYYMMDD or YYYYMMDD-N). */
  const FIRMWARE_RAW_URL_TEMPLATE = "https://raw.githubusercontent.com/Tango-FPGA/firmware-tango/main/releases/firmware-tango_{tag}.bin";

  /* The release asset's file name for a tag (YYYYMMDD or YYYYMMDD-N). */
  function firmwareAssetName(tag) {
    return TANGO_RELEASES.assetNameTemplate.replace("{tag}", tag);
  }

  /*
   * BL616 boot header (bouffalo_sdk bsp/board/bl616dk/fw_header.h, struct bootheader_t, 0x100 bytes):
   *   0x00 magiccode "BFNP"
   *   0x7c basic_cfg.group_image_offset  (offset of the image after the header)
   *   0x84 basic_cfg.img_len_cnt         (image length)
   *   0xfc crc32 over bytes 0x00..0xfb
   */
  const OFFSET_GROUP_IMAGE = 0x7c;
  const OFFSET_IMAGE_LENGTH = 0x84;
  const OFFSET_HEADER_CRC = 0xfc;

  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i += 1) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  function toBytes(data) {
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    throw new TypeError("expected bytes");
  }

  function bytesToHex(bytes) {
    return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  }

  async function sha256Hex(data) {
    const subtle = globalThis.crypto && globalThis.crypto.subtle;
    if (!subtle) throw new Error("This browser cannot compute SHA-256. Open the page from its secure (https) address.");
    return bytesToHex(new Uint8Array(await subtle.digest("SHA-256", toBytes(data))));
  }

  function formatBytes(n) {
    return `${n.toLocaleString("en-US")} bytes`;
  }

  function hex(n, width = 1) {
    return `0x${n.toString(16).toUpperCase().padStart(width, "0")}`;
  }

  function containsAscii(bytes, text) {
    const needle = Array.from(text, (ch) => ch.charCodeAt(0));
    const first = needle[0];
    const last = bytes.length - needle.length;
    outer: for (let i = bytes.indexOf(first); i >= 0 && i <= last; i = bytes.indexOf(first, i + 1)) {
      for (let j = 1; j < needle.length; j += 1) if (bytes[i + j] !== needle[j]) continue outer;
      return true;
    }
    return false;
  }

  /*
   * The firmware's build id is a NUL-terminated C string "g<hash>[-dirty] <YYYY-MM-DD> <HH:MM>"
   * (hash: 7 hex digits, or "nogit"). The firmware's About screen shows it as
   * "Tango FPGA v<yymmdd> (g<hash>[-dirty])". Returns the parsed id when exactly one distinct id is
   * found, otherwise null.
   */
  function parseFirmwareVersion(data) {
    const bytes = toBytes(data);
    const ids = new Set();
    let start = 0;
    for (let i = 0; i <= bytes.length; i += 1) {
      if (i < bytes.length && bytes[i] !== 0) continue;
      const length = i - start;
      if (length >= 23 && length <= 40) {
        let text = "";
        for (let j = start; j < i; j += 1) text += String.fromCharCode(bytes[j]);
        if (FIRMWARE_ID_PATTERN.test(text)) ids.add(text);
      }
      start = i + 1;
    }
    if (ids.size !== 1) return null;
    const id = ids.values().next().value;
    const [, build, year, month, day, time] = FIRMWARE_ID_PATTERN.exec(id);
    return {
      id,
      build,
      date: `${year}-${month}-${day}`,
      time,
      aboutText: `Tango FPGA v${year.slice(2)}${month}${day} (${build})`,
      display: `version ${year}-${month}-${day} (${build})`,
    };
  }

  /* Reads the boot header; returns { magic, crcOk, imageOffset, imageLength, declaredSize } or null if too short. */
  function readBootHeader(data) {
    const bytes = toBytes(data);
    if (bytes.length < BOOT_HEADER_SIZE) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, BOOT_HEADER_SIZE);
    const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
    const crcStored = view.getUint32(OFFSET_HEADER_CRC, true);
    const crcComputed = crc32(bytes.subarray(0, OFFSET_HEADER_CRC));
    const imageOffset = view.getUint32(OFFSET_GROUP_IMAGE, true);
    const imageLength = view.getUint32(OFFSET_IMAGE_LENGTH, true);
    return {
      magic,
      crcStored,
      crcComputed,
      crcOk: crcStored === crcComputed,
      imageOffset,
      imageLength,
      declaredSize: imageOffset + imageLength,
    };
  }

  function knownDebugger(sha256) {
    return KNOWN_DEBUGGER_BUILDS.find((entry) => entry.sha256 === sha256) || null;
  }

  /*
   * Header checks shared by both files. Returns a list of error strings (empty when the header is good).
   */
  function headerErrors(bytes, label, notThisKind) {
    if (bytes.length < BOOT_HEADER_SIZE || String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== BOOT_MAGIC) {
      return [`${notThisKind} ${notThisKind.endsWith(":") ? "it" : "It"} does not start with the Bouffalo boot header ("${BOOT_MAGIC}").`];
    }
    const header = readBootHeader(bytes);
    const errors = [];
    if (!header.crcOk) {
      errors.push(`The ${label} is damaged: its boot header checksum does not match. Download it again.`);
    } else if (header.declaredSize > bytes.length) {
      errors.push(
        `The ${label} is cut short: its header says ${formatBytes(header.declaredSize)}, ` +
          `but the file has only ${formatBytes(bytes.length)}. Download it again.`,
      );
    }
    return errors;
  }

  /*
   * File 1: the Sipeed debugger (FPGA Partner) image for flash 0x0.
   * Returns { ok, errors, warnings, known, needsAcknowledge, size, sha256 }.
   */
  function checkDebugger(data, sha256) {
    const bytes = toBytes(data);
    const result = { ok: false, errors: [], warnings: [], known: null, needsAcknowledge: false, size: bytes.length, sha256 };
    if (bytes.length === 0) {
      result.errors.push("The Sipeed debugger file is empty.");
      return result;
    }
    if (bytes.length >= FIRMWARE_ADDRESS) {
      if (containsAscii(bytes, FIRMWARE_MARKER)) {
        result.errors.push("This is the Tango firmware file, not the Sipeed debugger file. Put it in box 2.");
      } else {
        result.errors.push(
          `This file is too big to be the Sipeed debugger file: it has ${formatBytes(bytes.length)}, ` +
            `and it must be smaller than ${formatBytes(FIRMWARE_ADDRESS)}.`,
        );
      }
      return result;
    }
    result.errors.push(...headerErrors(bytes, "Sipeed debugger file", "This is not a Sipeed debugger file."));
    if (result.errors.length) return result;
    if (containsAscii(bytes, FIRMWARE_MARKER)) {
      result.errors.push("This is a Tango firmware file, not the Sipeed debugger file. Put it in box 2.");
      return result;
    }
    result.known = knownDebugger(sha256);
    if (!result.known) {
      result.needsAcknowledge = true;
      result.warnings.push(
        "This Sipeed debugger file is not one that has been tested with Tango (its SHA-256 is not on the list). " +
          "It may work, but if it does not, the board's USB debugger or the Tango firmware may not start. " +
          "Tick the box below only if you know you want this file.",
      );
    }
    result.ok = true;
    return result;
  }

  /*
   * File 2: the Tango firmware image for flash 0x40000.
   * Returns { ok, errors, warnings, version, size, sha256 }; version is parseFirmwareVersion() or null.
   */
  function checkFirmware(data, sha256, debuggerSha256 = null) {
    const bytes = toBytes(data);
    const result = { ok: false, errors: [], warnings: [], version: null, size: bytes.length, sha256 };
    if (bytes.length === 0) {
      result.errors.push("The Tango firmware file is empty.");
      return result;
    }
    if (knownDebugger(sha256) || (debuggerSha256 && sha256 === debuggerSha256)) {
      result.errors.push("This is the Sipeed debugger file, not the Tango firmware. Put the Tango firmware file (firmware-tango_<date>.bin) here.");
      return result;
    }
    result.errors.push(...headerErrors(bytes, "Tango firmware file", "This does not look like Tango firmware:"));
    if (result.errors.length) return result;
    if (!containsAscii(bytes, FIRMWARE_MARKER)) {
      result.errors.push(
        `This does not look like Tango firmware: it is a BL616 program, but it does not contain the text "${FIRMWARE_MARKER}". ` +
          "Put the Tango firmware file (firmware-tango_<date>.bin) here.",
      );
      return result;
    }
    result.version = parseFirmwareVersion(bytes);
    if (!result.version) result.warnings.push("This Tango firmware file does not say which version it is.");
    result.ok = true;
    return result;
  }

  /* One image for flash 0x0: debugger bytes, 0xFF up to 0x40000, firmware bytes. */
  function joinImage(debuggerData, firmwareData) {
    const first = toBytes(debuggerData);
    const second = toBytes(firmwareData);
    if (first.length === 0 || first.length >= FIRMWARE_ADDRESS) {
      throw new RangeError(`debugger image must be 1..${FIRMWARE_ADDRESS - 1} bytes, got ${first.length}`);
    }
    if (second.length === 0) throw new RangeError("firmware image is empty");
    const image = new Uint8Array(FIRMWARE_ADDRESS + second.length).fill(0xff);
    image.set(first, 0);
    image.set(second, FIRMWARE_ADDRESS);
    return image;
  }

  /*
   * One GET of `url` for a file, with a timeout and a size cap. `server` names the server in messages.
   * Returns { ok: true, bytes } or { ok: false, kind, status?, detail }, kind one of
   * "network" | "http" | "timeout" | "size". A declared Content-Length is only checked against maxBytes
   * (it may be the encoded size); the caller checks the body exactly.
   */
  async function downloadBytes({ fetchImpl, url, timeoutMs, maxBytes, server, expectedSize = null }) {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const limitText = () => (expectedSize ? `expected ${formatBytes(expectedSize)}` : `more than the ${formatBytes(maxBytes)} limit`);
    try {
      const response = await fetchImpl(url, {
        method: "GET",
        mode: "cors",
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
      });
      if (!response.ok) {
        return { ok: false, kind: "http", status: response.status, detail: `${server} answered with an error (HTTP ${response.status}).` };
      }
      const declared = Number(response.headers && response.headers.get ? response.headers.get("content-length") : NaN);
      if (Number.isFinite(declared) && declared > maxBytes) {
        controller.abort();
        return { ok: false, kind: "size", detail: `${server} offered ${formatBytes(declared)}, ${limitText()}.` };
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length > maxBytes) {
        return { ok: false, kind: "size", detail: `${server} sent ${formatBytes(bytes.length)}, ${limitText()}.` };
      }
      return { ok: true, bytes };
    } catch (error) {
      if (timedOut) {
        return { ok: false, kind: "timeout", detail: `${server} did not send the file within ${Math.round(timeoutMs / 1000)} seconds.` };
      }
      return { ok: false, kind: "network", detail: `The browser could not reach ${server}, or blocked the download.` };
    } finally {
      clearTimeout(timer);
    }
  }

  /* Upper bound on the Sipeed download (declared or received). */
  const MAX_DEBUGGER_DOWNLOAD_BYTES = 1024 * 1024;

  /*
   * Fetches SIPEED_DEBUGGER.url once and runs checkDebugger on it. A fetched file must be exactly the pinned
   * build (size and SHA-256); there is no acknowledgement path for it.
   * Returns { ok: true, bytes, check } or { ok: false, kind, detail }, kind one of
   * "network" | "http" | "timeout" | "size" | "hash" | "check".
   * options.fetchImpl is required; options.expect overrides { sha256, size } and options.timeoutMs the timeout.
   */
  async function fetchSipeedDebugger(options) {
    const expect = options.expect || SIPEED_DEBUGGER;
    const download = await downloadBytes({
      fetchImpl: options.fetchImpl,
      url: SIPEED_DEBUGGER.url,
      timeoutMs: options.timeoutMs || SIPEED_DEBUGGER.timeoutMs,
      maxBytes: MAX_DEBUGGER_DOWNLOAD_BYTES,
      server: "Sipeed's server",
      expectedSize: expect.size,
    });
    if (!download.ok) return download;
    const bytes = download.bytes;
    if (bytes.length !== expect.size) {
      return { ok: false, kind: "size", detail: `The downloaded file has ${formatBytes(bytes.length)}, expected ${formatBytes(expect.size)}.` };
    }
    const sha256 = await sha256Hex(bytes);
    if (sha256 !== expect.sha256) {
      return { ok: false, kind: "hash", detail: `The downloaded file is not the expected build (SHA-256 ${sha256}).` };
    }
    const check = checkDebugger(bytes, sha256);
    if (!check.ok) return { ok: false, kind: "check", detail: check.errors.join(" ") };
    return { ok: true, bytes, check };
  }

  function isValidDate(year, month, day) {
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  }

  /*
   * Validates a GitHub "latest release" object. Returns
   * { tag, date: "YYYY-MM-DD", display, assetName, downloadUrl, notesUrl, size, digest } or null. The asset's
   * digest ("sha256:<64 lowercase hex>") is required.
   */
  function parseLatestRelease(json) {
    if (!json || typeof json !== "object" || Array.isArray(json)) return null;
    const tag = json.tag_name;
    /* a release tag: the date code YYYYMMDD, or YYYYMMDD-N (N = 2, 3, ...: a further release on the same day) */
    if (typeof tag !== "string" || !/^\d{8}(?:-(?:[2-9]|[1-9]\d+))?$/.test(tag)) return null;
    const year = Number(tag.slice(0, 4));
    const month = Number(tag.slice(4, 6));
    const day = Number(tag.slice(6, 8));
    if (!isValidDate(year, month, day)) return null;
    if (json.draft === true || json.prerelease === true) return null;
    const notesUrl = json.html_url;
    if (notesUrl !== `${TANGO_RELEASES.tagUrlPrefix}${tag}`) return null;
    if (!Array.isArray(json.assets)) return null;
    const assetName = firmwareAssetName(tag);
    const matches = json.assets.filter((asset) => asset && asset.name === assetName);
    if (matches.length !== 1) return null;
    const asset = matches[0];
    const downloadUrl = asset.browser_download_url;
    if (typeof downloadUrl !== "string" || !downloadUrl.startsWith(TANGO_RELEASES.downloadUrlPrefix)) return null;
    if (downloadUrl !== `${TANGO_RELEASES.downloadUrlPrefix}${tag}/${assetName}`) return null;
    const size = Number.isSafeInteger(asset.size) && asset.size > 0 ? asset.size : null;
    const digestMatch = typeof asset.digest === "string" ? /^sha256:([0-9a-f]{64})$/.exec(asset.digest) : null;
    if (!digestMatch) return null;
    const date = `${tag.slice(0, 4)}-${tag.slice(4, 6)}-${tag.slice(6, 8)}`;
    return {
      tag,
      date,
      display: `version ${date} (release ${tag})`,
      assetName,
      downloadUrl,
      notesUrl,
      size,
      digest: digestMatch[1],
    };
  }

  /*
   * One GET of TANGO_RELEASES.apiUrl. Returns { ok: true, release } or { ok: false, kind } with kind one of
   * "network" | "http" | "timeout" | "data". options.fetchImpl is required.
   */
  async function fetchLatestRelease(options) {
    const fetchImpl = options.fetchImpl;
    const timeoutMs = options.timeoutMs || TANGO_RELEASES.timeoutMs;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      const response = await fetchImpl(TANGO_RELEASES.apiUrl, {
        method: "GET",
        mode: "cors",
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        headers: { Accept: "application/vnd.github+json" },
        signal: controller.signal,
      });
      if (!response.ok) return { ok: false, kind: "http", status: response.status };
      const text = await response.text();
      if (text.length > TANGO_RELEASES.maxResponseChars) return { ok: false, kind: "data" };
      let json;
      try {
        json = JSON.parse(text);
      } catch (_) {
        return { ok: false, kind: "data" };
      }
      const release = parseLatestRelease(json);
      return release ? { ok: true, release } : { ok: false, kind: "data" };
    } catch (_) {
      return { ok: false, kind: timedOut ? "timeout" : "network" };
    } finally {
      clearTimeout(timer);
    }
  }

  /*
   * Compares a passed box-2 check with the latest release. Returns null (nothing to say) or
   * { kind: "latest" | "newer-available", text }. Never affects whether Install is allowed.
   */
  function compareWithLatest(firmwareCheck, release) {
    if (!firmwareCheck || !firmwareCheck.ok || !release || !release.digest) return null;
    if (firmwareCheck.sha256 === release.digest) return { kind: "latest", text: "This is the latest Tango firmware." };
    if (firmwareCheck.version && firmwareCheck.version.date < release.date) {
      return {
        kind: "newer-available",
        text: `A newer Tango firmware is available (${release.display}). You can still install this one.`,
      };
    }
    return null;
  }

  /*
   * "Get it from GitHub for me": the latest release's metadata from the GitHub API, then the firmware bytes
   * from FIRMWARE_RAW_URL_TEMPLATE (release attachments cannot be read cross-origin). Accepted only when the
   * bytes' SHA-256 equals the release asset's digest and checkFirmware passes.
   * Returns { ok: true, bytes, check, release } or { ok: false, kind, detail, release (null unless the API
   * answered) }, kind one of "api-network" | "api-http" | "api-timeout" | "api-data" | "network" | "http" |
   * "timeout" | "size" | "digest" | "check".
   */
  async function fetchLatestFirmware(options) {
    const fetchImpl = options.fetchImpl;
    const api = await fetchLatestRelease({ fetchImpl, timeoutMs: options.apiTimeoutMs });
    if (!api.ok) {
      const detail = {
        network: "The browser could not reach GitHub, or blocked the request.",
        timeout: `GitHub did not answer within ${Math.round((options.apiTimeoutMs || TANGO_RELEASES.timeoutMs) / 1000)} seconds.`,
        data: "GitHub's answer about the latest Tango firmware release was not in the expected form.",
        http:
          api.status === 403 || api.status === 429
            ? `GitHub refused the request (HTTP ${api.status}): it limits how often one computer may ask. Try again later.`
            : `GitHub answered with an error (HTTP ${api.status}).`,
      }[api.kind];
      return { ok: false, kind: `api-${api.kind}`, detail, release: null };
    }
    const release = api.release;
    const download = await downloadBytes({
      fetchImpl,
      url: FIRMWARE_RAW_URL_TEMPLATE.replace("{tag}", release.tag),
      timeoutMs: options.timeoutMs || TANGO_RELEASES.downloadTimeoutMs,
      maxBytes: TANGO_RELEASES.maxDownloadBytes,
      server: "GitHub",
    });
    if (!download.ok) {
      const detail =
        download.kind === "http" && download.status === 404
          ? `The firmware file of release ${release.tag} is not available for download yet (HTTP 404).`
          : download.detail;
      return { ok: false, kind: download.kind, detail, release };
    }
    const bytes = download.bytes;
    const sha256 = await sha256Hex(bytes);
    if (sha256 !== release.digest) {
      return { ok: false, kind: "digest", detail: `The downloaded file does not match release ${release.tag} (SHA-256 ${sha256}).`, release };
    }
    const check = checkFirmware(bytes, sha256);
    if (!check.ok) return { ok: false, kind: "check", detail: `The downloaded file is not valid Tango firmware. ${check.errors.join(" ")}`, release };
    return { ok: true, bytes, check, release };
  }

  /*
   * The page's state: two files, the acknowledgement for an untested debugger build, and the joined image.
   * Choosing a new debugger file always clears the acknowledgement.
   */
  class TangoSession {
    constructor() {
      this.debugger = null;
      this.firmware = null;
      this.acknowledged = false;
    }

    /* source: "file" (picked by the user) or "sipeed" (fetched and already verified by fetchSipeedDebugger). */
    async setDebugger(data, name = "", source = "file") {
      const bytes = toBytes(data);
      const sha256 = await sha256Hex(bytes);
      const check = checkDebugger(bytes, sha256);
      if (source === "sipeed" && !(check.ok && check.known && sha256 === SIPEED_DEBUGGER.sha256)) {
        throw new Error("A file downloaded from Sipeed must be the pinned build.");
      }
      this.acknowledged = false;
      this.debugger = { name, bytes, source, check };
      if (this.firmware) this.firmware.check = checkFirmware(this.firmware.bytes, this.firmware.check.sha256, sha256);
      return this.debugger.check;
    }

    /* source: "file" (picked) or "github" (fetched by fetchLatestFirmware; must match release.digest). */
    async setFirmware(data, name = "", source = "file", release = null) {
      const bytes = toBytes(data);
      const sha256 = await sha256Hex(bytes);
      const check = checkFirmware(bytes, sha256, this.debugger ? this.debugger.check.sha256 : null);
      if (source === "github" && !(check.ok && release && release.digest === sha256)) {
        throw new Error("A file downloaded from GitHub must match the latest release.");
      }
      this.firmware = { name, bytes, source, release: source === "github" ? release : null, check };
      return this.firmware.check;
    }

    /* Empties box 1 (file, check and acknowledgement). */
    clearDebugger() {
      this.debugger = null;
      this.acknowledged = false;
      if (this.firmware) this.firmware.check = checkFirmware(this.firmware.bytes, this.firmware.check.sha256, null);
    }

    /* Empties box 2. */
    clearFirmware() {
      this.firmware = null;
    }

    setAcknowledged(value) {
      this.acknowledged = Boolean(value);
    }

    /* { ready, reasons }: reasons are plain-English sentences saying what is still missing. */
    readiness(connected = true) {
      const reasons = [];
      const d = this.debugger && this.debugger.check;
      const f = this.firmware && this.firmware.check;
      if (!d) reasons.push("Choose the Sipeed debugger file (box 1).");
      else if (!d.ok) reasons.push(...d.errors);
      else if (d.needsAcknowledge && !this.acknowledged) reasons.push("Tick the box to confirm the untested Sipeed debugger file.");
      if (!f) reasons.push("Choose the Tango firmware file (box 2).");
      else if (!f.ok) reasons.push(...f.errors);
      if (!connected) reasons.push("Connect to the board.");
      return { ready: reasons.length === 0, reasons };
    }

    /* The image to write at 0x0; throws unless every file check has passed. */
    image() {
      const state = this.readiness(true);
      if (!state.ready) throw new Error(state.reasons.join(" "));
      return joinImage(this.debugger.bytes, this.firmware.bytes);
    }
  }

  return Object.freeze({
    FIRMWARE_ADDRESS,
    BOOT_HEADER_SIZE,
    BOOT_MAGIC,
    FIRMWARE_MARKER,
    KNOWN_DEBUGGER_BUILDS,
    SIPEED_DEBUGGER,
    fetchSipeedDebugger,
    TANGO_RELEASES,
    parseLatestRelease,
    fetchLatestRelease,
    fetchLatestFirmware,
    FIRMWARE_RAW_URL_TEMPLATE,
    firmwareAssetName,
    compareWithLatest,
    crc32,
    sha256Hex,
    readBootHeader,
    checkDebugger,
    checkFirmware,
    joinImage,
    parseFirmwareVersion,
    formatBytes,
    hex,
    TangoSession,
  });
});
