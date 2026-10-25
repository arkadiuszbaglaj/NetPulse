"""Szyfrowanie sekretów: klucz z pliku (tworzony raz), szyfrowanie i odczyt, zły albo brakujący klucz."""

from __future__ import annotations

import threading

import pytest

from netpulse import crypto


@pytest.fixture(autouse=True)
def no_override():
    yield
    crypto.set_key(None)


def test_roundtrip_and_prefix():
    crypto.set_key("klucz-testowy")
    enc = crypto.encrypt("public")
    assert enc.startswith(crypto.PREFIX) and "public" not in enc
    assert crypto.decrypt(enc) == "public"
    assert crypto.encrypt(enc) == enc  # już zaszyfrowane – bez podwójnego szyfrowania
    assert crypto.encrypt(None) is None and crypto.encrypt("") == ""
    assert crypto.decrypt("jawny-tekst-sprzed-0.15") == "jawny-tekst-sprzed-0.15"
    assert crypto.encrypt("public") != enc  # losowy wektor: ta sama wartość, inny szyfrogram


def test_without_key_values_stay_plain_and_encrypted_read_as_empty():
    crypto.set_key("klucz-a")
    enc = crypto.encrypt("tajne")
    crypto.set_key("")
    assert not crypto.enabled()
    assert crypto.encrypt("tajne") == "tajne"
    assert crypto.decrypt(enc) is None
    crypto.set_key("inny-klucz")
    assert crypto.decrypt(enc) is None  # zły klucz – pusty sekret zamiast wyjątku


def test_key_file_created_once_and_shared(tmp_path):
    path = tmp_path / "secret.key"
    keys: list[str] = []
    threads = [threading.Thread(target=lambda: keys.append(crypto.load_or_create_key(path))) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(set(keys)) == 1 and len(keys[0]) == 64
    assert crypto.load_or_create_key(path) == keys[0]
    assert [p.name for p in tmp_path.iterdir()] == ["secret.key"]  # bez plików tymczasowych


def test_key_file_needs_existing_directory(tmp_path):
    assert crypto.load_or_create_key(tmp_path / "brak" / "secret.key") == ""


def test_type_decorator_uses_current_key():
    crypto.set_key("k")
    col = crypto.EncryptedText()
    stored = col.process_bind_param("abc", None)
    assert stored.startswith(crypto.PREFIX)
    assert col.process_result_value(stored, None) == "abc"
