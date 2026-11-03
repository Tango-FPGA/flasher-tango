# flasher-tango -- the Tango FPGA firmware installer

**Version 2026-11-03** (date code `20261103-2`)

flasher-tango is a web page that installs the **Tango FPGA** firmware on the **BL616** microcontroller of the
**Sipeed Tang Console 138K**. It runs in Chrome or Edge on a desktop or laptop computer and talks to the board over
USB. There is nothing to install.

**Open the installer: <https://tango-fpga.github.io/flasher-tango/>**

The Tango FPGA guides are in the [docs-tango wiki](https://github.com/Tango-FPGA/docs-tango/wiki). The firmware itself
is [firmware-tango](https://github.com/Tango-FPGA/firmware-tango).

## What it does

The installer writes two files to the BL616's flash in one pass:

1. **The Sipeed debugger file** (`bl616_fpga_partner_Console.bin`): Sipeed's own program for the board's USB
   debugger. It keeps the debugger working and starts the Tango firmware.
2. **The Tango firmware file** (`firmware-tango_<datecode>.bin`): the firmware from a
   [firmware-tango release](https://github.com/Tango-FPGA/firmware-tango/releases).

You can choose each file from your computer, or let the page download it with **Get it from Sipeed for me** and
**Get it from GitHub for me**. Before anything is sent to the board, the page checks each file: the debugger file
against the Sipeed build it knows (any other build needs your confirmation), and the firmware file for the Tango
firmware's signature and version. After writing, it reads back a checksum of the flash and compares it with the
files.

## Browsers

- **Chrome or Edge** on Windows, macOS, Linux or ChromeOS. The page uses Web Serial, which these browsers have.
- **Not Firefox or Safari**, and not phones or tablets: they have no Web Serial. The page says so when it opens in
  one of them.

## Privacy

- Your files stay on your computer. The page reads and joins them in the browser and sends them only to the board,
  over USB. Nothing is uploaded.
- Opening the page loads only the page's own files from this site.
- **Get it from Sipeed for me** downloads one file from Sipeed's server (`api.dl.sipeed.com`), and only when you
  click it.
- **Get it from GitHub for me** asks GitHub for the latest firmware-tango release (`api.github.com`) and downloads
  that release's firmware file (`raw.githubusercontent.com`), and only when you click it.
- No other server is contacted. The page's content security policy allows only its own files and these three
  addresses. It sends no cookies, credentials or referrer with these downloads.

## Running it yourself

The page is static files only. To run your own copy, serve this repository's files over HTTPS, or on your own
computer at `localhost` (Web Serial needs one of the two), for example:

    python3 -m http.server --bind 127.0.0.1 8000

then open `http://127.0.0.1:8000/` in Chrome or Edge.

## Licence

The installer is licensed under the Apache License, Version 2.0; see [LICENSE](LICENSE). It is derived from
`bflb_flash_web`, part of Bouffalo Lab's [bouffalo_sdk](https://github.com/bouffalolab/bouffalo_sdk) (folder
`tools/bflb_flash_web`, commit `82efe4ef797e190880706f9cff1809b423e20847`, SDK release 2.3.37), also Apache-2.0.
[NOTICE](NOTICE) lists what was changed from the original. Each modified file says so in its header.

The wordmark font, Saira Condensed SemiBold (`fonts/SairaCondensed-SemiBold.ttf`, copyright The Saira Project
Authors), is not part of the installer's code: it is licensed under the SIL Open Font License 1.1; see
[fonts/OFL.txt](fonts/OFL.txt).
