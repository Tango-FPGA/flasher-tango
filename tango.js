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

  /*
   * The Tango firmware releases: every release's image is in the releases/ folder on main of the firmware
   * repository, as firmware-tango_<tag>.bin ({tag}: YYYYMMDD or YYYYMMDD-N). releases/latest.json names the newest
   * one ({ tag, file, size, sha256 }); while that file does not exist (HTTP 404), the newest image is found in the
   * GitHub contents API listing of releases/ instead (size and git blob SHA-1 per file).
   */
  const TANGO_RELEASES = Object.freeze({
    latestUrl: "https://raw.githubusercontent.com/Tango-FPGA/firmware-tango/main/releases/latest.json",
    listingUrl: "https://api.github.com/repos/Tango-FPGA/firmware-tango/contents/releases?ref=main",
    pageUrl: "https://github.com/Tango-FPGA/firmware-tango/tree/main/releases",
    notesUrlPrefix: "https://github.com/Tango-FPGA/firmware-tango/tree/",
    fileUrlPrefix: "https://github.com/Tango-FPGA/firmware-tango/raw/main/releases/",
    fileNameTemplate: "firmware-tango_{tag}.bin",
    timeoutMs: 10000,
    maxResponseChars: 1024 * 1024,
    downloadTimeoutMs: 20000,
    maxDownloadBytes: 4 * 1024 * 1024,
  });

  /* Where "Get it from GitHub for me" reads the firmware bytes; {tag} is the release tag (YYYYMMDD or YYYYMMDD-N). */
  const FIRMWARE_RAW_URL_TEMPLATE = "https://raw.githubusercontent.com/Tango-FPGA/firmware-tango/main/releases/firmware-tango_{tag}.bin";

  /* A release's image file name for a tag (YYYYMMDD or YYYYMMDD-N). */
  function firmwareAssetName(tag) {
    return TANGO_RELEASES.fileNameTemplate.replace("{tag}", tag);
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

  /* git's object id of a file's bytes: SHA-1 of "blob <length>\0" followed by the bytes. */
  async function gitBlobSha(data) {
    const subtle = globalThis.crypto && globalThis.crypto.subtle;
    if (!subtle) throw new Error("This browser cannot compute SHA-1. Open the page from its secure (https) address.");
    const bytes = toBytes(data);
    const header = Array.from(`blob ${bytes.length}\0`, (ch) => ch.charCodeAt(0));
    const object = new Uint8Array(header.length + bytes.length);
    object.set(header, 0);
    object.set(bytes, header.length);
    return bytesToHex(new Uint8Array(await subtle.digest("SHA-1", object)));
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

  /* A release tag: the date code YYYYMMDD (a real date), or YYYYMMDD-N (N = 2, 3, ...: a further release on the same day). */
  const TAG_PATTERN = /^\d{8}(?:-(?:[2-9]|[1-9]\d+))?$/;

  /* [YYYYMMDD, N] of a valid tag (N = 1 without a suffix), or null. Releases sort by it. */
  function tagKey(tag) {
    if (typeof tag !== "string" || !TAG_PATTERN.test(tag)) return null;
    const year = Number(tag.slice(0, 4));
    const month = Number(tag.slice(4, 6));
    const day = Number(tag.slice(6, 8));
    if (!isValidDate(year, month, day)) return null;
    return [Number(tag.slice(0, 8)), tag.length > 8 ? Number(tag.slice(9)) : 1];
  }

  /* Negative, zero or positive as tag a is older than, the same as, or newer than tag b (both valid). */
  function compareTags(a, b) {
    const ka = tagKey(a);
    const kb = tagKey(b);
    return ka[0] - kb[0] || ka[1] - kb[1];
  }

  /*
   * The release object for a valid tag: { tag, date: "YYYY-MM-DD", display, assetName, rawUrl, downloadUrl, notesUrl,
   * size, digest (SHA-256, or null), gitSha (git blob SHA-1, or null), via ("latest.json" | "listing") }.
   */
  function makeRelease(tag, size, digest, gitSha, via) {
    const date = `${tag.slice(0, 4)}-${tag.slice(4, 6)}-${tag.slice(6, 8)}`;
    const assetName = firmwareAssetName(tag);
    return {
      tag,
      date,
      display: `version ${date} (release ${tag})`,
      assetName,
      rawUrl: FIRMWARE_RAW_URL_TEMPLATE.replace("{tag}", tag),
      downloadUrl: `${TANGO_RELEASES.fileUrlPrefix}${assetName}`,
      notesUrl: `${TANGO_RELEASES.notesUrlPrefix}${tag}`,
      size,
      digest,
      gitSha,
      via,
    };
  }

  function validSize(size) {
    return Number.isSafeInteger(size) && size > 0 && size <= TANGO_RELEASES.maxDownloadBytes;
  }

  /*
   * Validates releases/latest.json: { "tag": "<YYYYMMDD[-N]>", "file": "firmware-tango_<tag>.bin", "size": <bytes>,
   * "sha256": "<64 lowercase hex>" } (other keys are ignored). Returns a release object or null.
   */
  function parseLatestManifest(json) {
    if (!json || typeof json !== "object" || Array.isArray(json)) return null;
    const tag = json.tag;
    if (!tagKey(tag)) return null;
    if (json.file !== firmwareAssetName(tag)) return null;
    if (!validSize(json.size)) return null;
    if (typeof json.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(json.sha256)) return null;
    return makeRelease(tag, json.size, json.sha256, null, "latest.json");
  }

  /*
   * Validates the GitHub contents API listing of releases/ (an array of entries) and picks the newest release image:
   * entries named firmware-tango_<tag>.bin with a valid tag, ordered by date code, then by the same-day number.
   * Other names are ignored. A firmware entry must be a file at releases/<name> with a size up to the download cap
   * and a 40-hex git blob SHA-1. Returns a release object or null (also when there is no firmware entry).
   */
  function parseReleaseListing(json) {
    if (!Array.isArray(json)) return null;
    let newest = null;
    for (const entry of json) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
      const match = typeof entry.name === "string" ? /^firmware-tango_(.+)\.bin$/.exec(entry.name) : null;
      if (!match || !tagKey(match[1]) || entry.name !== firmwareAssetName(match[1])) continue;
      if (entry.type !== "file" || entry.path !== `releases/${entry.name}`) return null;
      if (!validSize(entry.size)) return null;
      if (typeof entry.sha !== "string" || !/^[0-9a-f]{40}$/.test(entry.sha)) return null;
      if (!newest || compareTags(match[1], newest.tag) > 0) newest = { tag: match[1], size: entry.size, sha: entry.sha };
    }
    return newest ? makeRelease(newest.tag, newest.size, null, newest.sha, "listing") : null;
  }

  /* True when the bytes' hashes match every hash the release names (at least one). */
  function matchesRelease(release, sha256, gitSha) {
    if (!release || !(release.digest || release.gitSha)) return false;
    if (release.digest && release.digest !== sha256) return false;
    if (release.gitSha && release.gitSha !== gitSha) return false;
    return true;
  }

  /*
   * One GET of a JSON document, with a timeout and a size cap. Returns { ok: true, json } or
   * { ok: false, kind, status? }, kind one of "network" | "http" | "timeout" | "data".
   */
  async function fetchJson(fetchImpl, url, timeoutMs, headers) {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      const init = {
        method: "GET",
        mode: "cors",
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
      };
      if (headers) init.headers = headers;
      const response = await fetchImpl(url, init);
      if (!response.ok) return { ok: false, kind: "http", status: response.status };
      const text = await response.text();
      if (text.length > TANGO_RELEASES.maxResponseChars) return { ok: false, kind: "data" };
      try {
        return { ok: true, json: JSON.parse(text) };
      } catch (_) {
        return { ok: false, kind: "data" };
      }
    } catch (_) {
      return { ok: false, kind: timedOut ? "timeout" : "network" };
    } finally {
      clearTimeout(timer);
    }
  }

  /*
   * Finds the latest release: one GET of TANGO_RELEASES.latestUrl; only if that answers HTTP 404 (no latest.json
   * yet), one GET of TANGO_RELEASES.listingUrl. Any other failure of latest.json is final. Returns
   * { ok: true, release } or { ok: false, kind, status?, source } with kind one of "network" | "http" | "timeout" |
   * "data" and source "latest.json" | "listing". options.fetchImpl is required.
   */
  async function fetchLatestRelease(options) {
    const fetchImpl = options.fetchImpl;
    const timeoutMs = options.timeoutMs || TANGO_RELEASES.timeoutMs;
    const latest = await fetchJson(fetchImpl, TANGO_RELEASES.latestUrl, timeoutMs);
    if (latest.ok) {
      const release = parseLatestManifest(latest.json);
      return release ? { ok: true, release } : { ok: false, kind: "data", source: "latest.json" };
    }
    if (!(latest.kind === "http" && latest.status === 404)) return { ...latest, source: "latest.json" };
    const listing = await fetchJson(fetchImpl, TANGO_RELEASES.listingUrl, timeoutMs, { Accept: "application/vnd.github+json" });
    if (!listing.ok) return { ...listing, source: "listing" };
    const release = parseReleaseListing(listing.json);
    return release ? { ok: true, release } : { ok: false, kind: "data", source: "listing" };
  }

  /*
   * Compares a passed box-2 check with the latest release. Returns null (nothing to say) or
   * { kind: "latest" | "newer-available", text }. Never affects whether Install is allowed.
   */
  function compareWithLatest(firmwareCheck, release) {
    if (!firmwareCheck || !firmwareCheck.ok || !release || !(release.digest || release.gitSha)) return null;
    if (matchesRelease(release, firmwareCheck.sha256, firmwareCheck.gitSha)) {
      return { kind: "latest", text: "This is the latest Tango firmware." };
    }
    if (firmwareCheck.version && firmwareCheck.version.date < release.date) {
      return {
        kind: "newer-available",
        text: `A newer Tango firmware is available (${release.display}). You can still install this one.`,
      };
    }
    return null;
  }

  /*
   * "Get it from GitHub for me": the latest release (fetchLatestRelease), then the firmware bytes from
   * FIRMWARE_RAW_URL_TEMPLATE. Accepted only when the bytes have exactly the release's size, match its hashes
   * (SHA-256 from latest.json, or the git blob SHA-1 from the listing) and pass checkFirmware.
   * Returns { ok: true, bytes, check, release } or { ok: false, kind, detail, release (null unless the latest release
   * was found) }, kind one of "api-network" | "api-http" | "api-timeout" | "api-data" | "network" | "http" |
   * "timeout" | "size" | "digest" | "check".
   */
  async function fetchLatestFirmware(options) {
    const fetchImpl = options.fetchImpl;
    const api = await fetchLatestRelease({ fetchImpl, timeoutMs: options.apiTimeoutMs });
    if (!api.ok) {
      const detail = {
        network: "The browser could not reach GitHub, or blocked the request.",
        timeout: `GitHub did not answer within ${Math.round((options.apiTimeoutMs || TANGO_RELEASES.timeoutMs) / 1000)} seconds.`,
        data:
          api.source === "latest.json"
            ? "The description of the latest Tango firmware release (releases/latest.json) was not in the expected form."
            : "GitHub's list of the Tango firmware releases was not in the expected form.",
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
      url: release.rawUrl,
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
    if (bytes.length !== release.size) {
      return {
        ok: false,
        kind: "size",
        detail: `The downloaded file has ${formatBytes(bytes.length)}, but release ${release.tag} has ${formatBytes(release.size)}.`,
        release,
      };
    }
    const sha256 = await sha256Hex(bytes);
    const gitSha = await gitBlobSha(bytes);
    if (!matchesRelease(release, sha256, gitSha)) {
      return { ok: false, kind: "digest", detail: `The downloaded file does not match release ${release.tag} (SHA-256 ${sha256}).`, release };
    }
    const check = checkFirmware(bytes, sha256);
    if (!check.ok) return { ok: false, kind: "check", detail: `The downloaded file is not valid Tango firmware. ${check.errors.join(" ")}`, release };
    check.gitSha = gitSha;
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
      if (this.firmware) this.recheckFirmware(sha256);
      return this.debugger.check;
    }

    /*
     * source: "file" (picked) or "github" (fetched by fetchLatestFirmware; must match the release's hashes).
     * The check also carries the file's git blob SHA-1 (gitSha), which compareWithLatest uses for a release found in
     * the listing.
     */
    async setFirmware(data, name = "", source = "file", release = null) {
      const bytes = toBytes(data);
      const sha256 = await sha256Hex(bytes);
      const gitSha = await gitBlobSha(bytes);
      const check = checkFirmware(bytes, sha256, this.debugger ? this.debugger.check.sha256 : null);
      check.gitSha = gitSha;
      if (source === "github" && !(check.ok && release && release.size === bytes.length && matchesRelease(release, sha256, gitSha))) {
        throw new Error("A file downloaded from GitHub must match the latest release.");
      }
      this.firmware = { name, bytes, source, release: source === "github" ? release : null, check };
      return this.firmware.check;
    }

    /* Runs box 2's checks again against a new box-1 hash (or none). */
    recheckFirmware(debuggerSha256) {
      const gitSha = this.firmware.check.gitSha;
      this.firmware.check = checkFirmware(this.firmware.bytes, this.firmware.check.sha256, debuggerSha256);
      this.firmware.check.gitSha = gitSha;
    }

    /* Empties box 1 (file, check and acknowledgement). */
    clearDebugger() {
      this.debugger = null;
      this.acknowledged = false;
      if (this.firmware) this.recheckFirmware(null);
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
    tagKey,
    compareTags,
    parseLatestManifest,
    parseReleaseListing,
    matchesRelease,
    fetchLatestRelease,
    fetchLatestFirmware,
    FIRMWARE_RAW_URL_TEMPLATE,
    firmwareAssetName,
    compareWithLatest,
    crc32,
    sha256Hex,
    gitBlobSha,
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
