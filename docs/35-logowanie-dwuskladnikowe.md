# Logowanie dwuskładnikowe – TOTP (0.63.0)

Każde konto może włączyć drugi składnik logowania: kod z aplikacji uwierzytelniającej (Google Authenticator, Aegis,
Bitwarden, 1Password, Microsoft Authenticator…). Wykradzione hasło samo wtedy nie wystarczy.

## Włączenie (Ustawienia → Konto → Logowanie dwuskładnikowe)

1. „Włącz” i własne hasło (potwierdzenie, że to Ty).
2. Zeskanuj kod QR aplikacją (albo przepisz klucz) i wpisz pokazany kod – dopiero wtedy 2FA zaczyna działać.
3. Panel pokaże **10 kodów zapasowych** (`xxxx-xxxx`, każdy działa raz) – skopiuj albo pobierz plik. Później ich nie
   zobaczysz; „Nowe kody zapasowe” (hasło + kod) wystawia nowy komplet, a stare przestają działać.

Włączenie wylogowuje pozostałe sesje tego konta. Wyłączenie: hasło + kod (albo kod zapasowy).

## Logowanie

Login i hasło jak zwykle; gdy konto ma 2FA, panel dopyta o kod (6 cyfr albo kod zapasowy). Kod z sąsiedniego
okna 30 s też przechodzi (zegar telefonu), ale każdego kodu można użyć tylko raz. Zły kod liczy się do limitu
nieudanych logowań (10 w 15 min z jednego adresu) i trafia do dziennika zdarzeń jako „Nieudane logowanie – zły kod 2FA”;
logowanie kodem zapasowym jest w dzienniku z liczbą pozostałych kodów.

## Zgubiony telefon i kody zapasowe

- administrator: Ustawienia → Konta → edycja konta → „Wyłącz logowanie dwuskładnikowe” (konto loguje się od nowa samym hasłem),
- na serwerze: `uplinkview user 2fa-off <login>` (także dla jedynego administratora).

`uplinkview user list` pokazuje, które konta mają 2FA.

## Szczegóły

- `backend/netpulse/totp.py` – RFC 6238 (SHA-1, 6 cyfr, 30 s, okno ±1), bez zewnętrznej biblioteki; kod QR: `segno`.
- `users.totp_secret` (zaszyfrowany jak inne sekrety, `EncryptedText`), `totp_enabled`, `totp_last_step`
  (ochrona przed ponownym użyciem kodu), `totp_recovery` (skróty SHA-256 kodów zapasowych) – migracja `0015`.
- API: `GET /api/auth/totp`, `POST /api/auth/totp/setup|enable|disable|recovery` (każda rola – własne konto),
  `POST /api/auth/login` z polem `code`; bez kodu odpowiedź 401 `{"detail": {"code": "totp_required", …}}`, zły kod –
  `totp_invalid`. Administrator: `PATCH /api/users/{id}` z `reset_totp: true`.
- Panel: `components/TwoFactorCard.tsx`, drugi krok w `auth/AuthPage.tsx` (`ApiError.code`).

## Jak sprawdzić

1. Ustawienia → Konto → „Włącz”, zeskanuj kod QR, wpisz kod, zapisz kody zapasowe.
2. Wyloguj się i zaloguj ponownie – po haśle panel zapyta o kod.
3. Zaloguj się raz kodem zapasowym – w Koncie liczba kodów spadnie do 9, a w Dzienniku zdarzeń będzie wpis.
