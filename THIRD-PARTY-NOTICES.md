# Third-party notices

Fetch itself is GPL-3.0-or-later (see `LICENSE`). It also ships and depends on the
work below. This file exists so that everything Fetch distributes is accounted for.

## FFmpeg 9.0  (bundled binary, `vendor/ffmpeg`)

Fetch ships a compiled FFmpeg executable and runs it as a **separate process**. It
does not link any `libav*` library into the application.

This build is configured with `--enable-gpl` and includes **libx264**, **libx265**
and **libvidstab**, all of which are GPLv2-or-later. **The bundled binary is therefore
covered by the GNU General Public License, version 2 or later.**

Copyright (c) 2000-2026 the FFmpeg developers.
FFmpeg is free software; you can redistribute it and/or modify it under the terms of
the GNU General Public License as published by the Free Software Foundation; either
version 2 of the License, or (at your option) any later version. The full text is in
`LICENSE` (GPL-3.0 is a later version of the same license).

### Written offer of source code

The complete corresponding source for the FFmpeg build shipped with Fetch, and for
the GPL libraries linked into it, is available for at least three years from the date
you received this software. Request it by opening an issue at
<https://github.com/SankrityaT/Fetch/issues> or by email, and you will be sent the
sources on a physical medium or by download, at no charge beyond the cost of
distribution.

Upstream sources:

- FFmpeg 9.0: <https://ffmpeg.org/releases/> and <https://git.ffmpeg.org/ffmpeg.git>
- x264: <https://code.videolan.org/videolan/x264>
- x265: <https://bitbucket.org/multicoreware/x265_git>
- vid.stab: <https://github.com/georgmartius/vid.stab>

### Build recipe

The exact configuration this binary was built with, which forms part of the
"scripts used to control compilation" the GPL requires:

```
     --prefix=/Volumes/tempdisk/sw --extra-cflags=-fno-stack-check --arch=arm64 
    --cc=/usr/bin/clang --enable-gpl --enable-libvmaf --enable-libopenjpeg 
    --enable-libopus --enable-libmp3lame --enable-libx264 --enable-libx265 
    --enable-libvvenc --enable-libvpx --enable-libwebp --enable-libass 
    --enable-libfreetype --enable-fontconfig --enable-libtheora 
    --enable-libvorbis --enable-libsnappy --enable-libaom --enable-libvidstab 
    --enable-libzimg --enable-libsvtav1 --enable-libharfbuzz --enable-libkvazaar 
    --pkg-config-flags=--static --enable-ffplay --enable-neon 
    --enable-runtime-cpudetect --disable-indev=qtkit --disable-indev=x11grab_xcb  
    Exiting with exit code 0 
```

### Libraries compiled into that binary

| Library | License |
|---|---|
| libx264, libx265, libvidstab | GPLv2-or-later (these are what make the binary GPL) |
| libmp3lame, libkvazaar | LGPLv2.1-or-later |
| libopus, libvorbis, libtheora, libvpx, libwebp, libsnappy | BSD |
| libaom, libsvtav1 | BSD + AOM patent grant |
| libvmaf, libopenjpeg | BSD-2 |
| libass | ISC |
| libfreetype | FTL or GPLv2 (dual) |
| fontconfig, libharfbuzz | MIT-style |
| libvvenc | BSD-3 (modified) |
| libzimg | WTFPL |

Note on patents: H.264 and HEVC are subject to patent licensing (Via LA / MPEG-LA)
in some jurisdictions. That is separate from copyright licensing and is not resolved
by the GPL.

## Speech recognition

On-device transcription uses **FluidAudio** with the **Parakeet** model, invoked as a
separate process (`Transcribe.app`). See <https://github.com/FluidInference/FluidAudio>
for its license and model terms. The model is not redistributed in this repository.

## Fonts (`assets/fonts/`)

| Font | License |
|---|---|
| Bricolage Grotesque | SIL Open Font License 1.1 |
| Geist, Geist Mono | SIL Open Font License 1.1 |
| Instrument Serif | SIL Open Font License 1.1 |

## Icons

Phosphor Icons, MIT. <https://phosphoricons.com>

## Electron

Electron and Chromium are distributed under the MIT license and the licenses listed
in the Chromium source tree. See <https://github.com/electron/electron>.

## Mascot artwork

The Biscuit artwork in `assets/mascot/` was generated with AI image tools and is
released under the same GPL-3.0-or-later terms as the rest of this repository.
