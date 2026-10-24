#!/usr/bin/env python3
"""Generuje ikony panelu (favicon.ico, apple-touch-icon, ikony PWA) z logo NetPulse.

Logo to ten sam rysunek co `public/favicon.svg` i komponent `Logo` w `src/components/ui.tsx`:
niebieski kwadrat z zaokrąglonymi rogami i biała linia tętna. Zmiana logo = zmiana stałych
poniżej + `public/favicon.svg`, potem:

    pip install pillow
    python frontend/tools/make-icons.py
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

PUBLIC = Path(__file__).resolve().parent.parent / "public"

BLUE = (24, 95, 165, 255)  # #185FA5
WHITE = (255, 255, 255, 255)
# Współrzędne w siatce 32x32 – jak w favicon.svg
PULSE = [(4, 17), (10, 17), (13, 8), (18, 25), (21, 14), (23, 17), (28, 17)]
STROKE = 2.4
RADIUS = 7
SUPERSAMPLE = 8  # rysujemy w większej skali i zmniejszamy – gładkie krawędzie


def logo(size: int, padding: float = 0.0, background: bool = True) -> Image.Image:
    """Logo w podanym rozmiarze. `padding` (0–0.4) zostawia margines, np. na maskowane ikony Androida."""
    big = size * SUPERSAMPLE
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    if background:
        draw.rounded_rectangle([0, 0, big - 1, big - 1], radius=big * RADIUS / 32, fill=BLUE)

    inner = big * (1 - 2 * padding)
    offset = big * padding
    scale = inner / 32

    def pt(p: tuple[float, float]) -> tuple[float, float]:
        return offset + p[0] * scale, offset + p[1] * scale

    pts = [pt(p) for p in PULSE]
    width = max(1, round(STROKE * scale))
    draw.line(pts, fill=WHITE, width=width, joint="curve")
    r = width / 2  # okrągłe końce i załamania linii
    for x, y in pts:
        draw.ellipse([x - r, y - r, x + r, y + r], fill=WHITE)

    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    PUBLIC.mkdir(parents=True, exist_ok=True)

    # favicon.ico z kilkoma rozmiarami (przeglądarki wybierają właściwy)
    base = logo(256)
    base.save(PUBLIC / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)])

    def square(size: int, padding: float) -> Image.Image:
        """Pełny kwadrat bez zaokrągleń – rogi zaokrągla system (iOS) albo maska (Android)."""
        img = Image.new("RGBA", (size, size), BLUE)
        img.alpha_composite(logo(size, padding=padding, background=False))
        return img

    square(180, 0.1).save(PUBLIC / "apple-touch-icon.png")
    logo(192).save(PUBLIC / "icon-192.png")
    logo(512).save(PUBLIC / "icon-512.png")
    # Maskowana (Android): logo w bezpiecznej strefie ~80% środka
    square(512, 0.18).save(PUBLIC / "icon-maskable-512.png")

    for f in sorted(PUBLIC.iterdir()):
        print(f"{f.name:28} {f.stat().st_size:>7} B")


if __name__ == "__main__":
    main()
