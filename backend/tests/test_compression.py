"""Kompresja TimescaleDB (od 0.67.0) – ustawienia bez bazy: każda hypertable ma wpis, kolumny istnieją."""

from netpulse import compression
from netpulse.db.models import HYPERTABLES, Base


def test_every_hypertable_has_segment_by_with_real_columns():
    assert set(compression.SEGMENT_BY) == set(HYPERTABLES)
    for table, columns in compression.SEGMENT_BY.items():
        have = {c.name for c in Base.metadata.tables[table].columns}
        assert set(columns) <= have, f"{table}: {set(columns) - have}"
        assert "time" not in columns  # czas porządkuje wiersze w segmencie, nie dzieli na segmenty


def test_segment_by_matches_object_index():
    """Segment = obiekt, po którym filtrują zapytania: te same kolumny co indeks (obiekt, time) z 0.65.4."""
    for table, columns in compression.SEGMENT_BY.items():
        indexes = [[c.name for c in i.columns] for i in Base.metadata.tables[table].indexes]
        by_object = [cols[:-1] for cols in indexes if cols[-1] == "time" and len(cols) > 1]
        if by_object:
            assert any(tuple(cols) == columns[: len(cols)] for cols in by_object), f"{table}: {columns} vs {by_object}"


def test_compress_after_days_stays_below_retention():
    assert compression.compress_after_days(30, 7) == 7
    assert compression.compress_after_days(5, 7) == 4  # retencja krótsza niż 7 dni: dzień przed usunięciem
    assert compression.compress_after_days(1, 7) == 1
    assert compression.compress_after_days(30, 1) == 1


def test_settings_sql():
    sql = compression.settings_sql("metrics")
    assert sql.startswith("ALTER TABLE metrics SET (timescaledb.compress")
    assert "compress_segmentby = 'device_id, name, key'" in sql
    assert "compress_orderby = 'time DESC'" in sql
    assert "segmentby" not in compression.settings_sql("system_metrics")
