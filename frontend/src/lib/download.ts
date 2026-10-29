/** Zapis pliku z przeglądarki (eksport wykresu): tekst/Blob albo adres `data:` (obraz z ECharts). */
export function download(name: string, data: Blob | string) {
  const url = typeof data === "string" ? data : URL.createObjectURL(data);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  if (typeof data !== "string") setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Nazwa pliku z tytułu i chwili eksportu: „ruch-wan-2026-10-29-1205”. */
export function fileName(title: string, ext: string, now = new Date()): string {
  const slug =
    title
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/ł/g, "l")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "wykres";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${slug}-${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}.${ext}`;
}
