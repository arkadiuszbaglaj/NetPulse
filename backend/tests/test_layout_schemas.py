"""Schemat układu pulpitu: ścisła walidacja danych od użytkownika (bez bazy)."""

import pytest
from pydantic import ValidationError

from netpulse.api.layout_schemas import (
    ALLOWED_METRICS,
    MAX_WIDGETS,
    ChartConfig,
    DashboardLayout,
    RefreshPrefs,
)


def chart(**over):
    base = {
        "id": "c1",
        "type": "chart",
        "w": 6,
        "config": {"source": {"kind": "wan"}, "series": [{"key": "in_bps"}, {"key": "out_bps", "color": 2}]},
    }
    base["config"].update(over.pop("config", {}))
    base.update(over)
    return base


def layout(*widgets):
    return {"version": 1, "widgets": list(widgets)}


def test_valid_layout_and_defaults():
    parsed = DashboardLayout.model_validate(
        layout(
            {"id": "s", "type": "summary", "w": 12, "config": {"tiles": ["devices", "wan_down"]}},
            chart(),
            {"id": "d", "type": "devices", "w": 12},
        )
    )
    assert [w.type for w in parsed.widgets] == ["summary", "chart", "devices"]
    c = parsed.widgets[1].config
    assert c.chart == "area" and c.unit == "bits" and c.smooth is False and c.height == "md"
    assert c.range_min is None and c.refresh_s is None  # puste = ustawienia globalne
    assert parsed.widgets[2].config.kinds is None


def test_every_source_accepts_its_own_metrics():
    sources = {
        "wan": {"kind": "wan"},
        "interface": {"kind": "interface", "id": 3},
        "device": {"kind": "device", "id": 1},
        "wifi_total": {"kind": "wifi_total"},
        "wifi_network": {"kind": "wifi_network", "id": 7},
        "server": {"kind": "server"},
        "agent_cpu": {"kind": "agent_cpu", "id": 2},
        "agent_net": {"kind": "agent_net", "id": 2, "key": "eth0"},
        "agent_disk": {"kind": "agent_disk", "id": 2, "key": "sda"},
        "agent_temp": {"kind": "agent_temp", "id": 2, "key": "coretemp/Core 0"},
        "agent_container": {"kind": "agent_container", "id": 2, "key": "nextcloud"},
        "pve_guest": {"kind": "pve_guest", "id": 3, "key": "nextcloud (105)"},
    }
    assert set(sources) == set(ALLOWED_METRICS)
    for kind, source in sources.items():
        series = [{"key": k} for k in ALLOWED_METRICS[kind]]
        ChartConfig.model_validate({"source": source, "series": series[:6]})


def test_interface_and_wifi_sources_remember_their_device():
    for source in ({"kind": "interface", "id": 7, "device_id": 2}, {"kind": "wifi_network", "id": 3, "device_id": 4}):
        parsed = ChartConfig.model_validate({"source": source, "series": [{"key": "clients" if source["kind"] == "wifi_network" else "in_bps"}]})
        assert parsed.source.device_id == source["device_id"]
    with pytest.raises(ValidationError):
        ChartConfig.model_validate({"source": {"kind": "interface", "id": 7, "device_id": 0}, "series": [{"key": "in_bps"}]})
    with pytest.raises(ValidationError):  # urządzenie i WAN nie mają pola device_id
        ChartConfig.model_validate({"source": {"kind": "wan", "device_id": 1}, "series": [{"key": "in_bps"}]})


@pytest.mark.parametrize(
    ("source", "key"),
    [
        ({"kind": "wan"}, "cpu_percent"),
        ({"kind": "device", "id": 1}, "in_bps"),
        ({"kind": "wifi_total"}, "rx_bps"),
        ({"kind": "interface", "id": 1}, "clients"),
    ],
)
def test_metric_must_belong_to_source(source, key):
    with pytest.raises(ValidationError, match="nie jest dostępna"):
        ChartConfig.model_validate({"source": source, "series": [{"key": key}]})


def test_rejects_duplicate_series_and_unknown_fields():
    with pytest.raises(ValidationError, match="nie mogą się powtarzać"):
        ChartConfig.model_validate({"source": {"kind": "wan"}, "series": [{"key": "in_bps"}, {"key": "in_bps"}]})
    with pytest.raises(ValidationError):
        DashboardLayout.model_validate(layout(chart(config={"nieznane": 1})))
    with pytest.raises(ValidationError):
        DashboardLayout.model_validate({"version": 1, "widgets": [], "dodatkowe": True})


@pytest.mark.parametrize(
    "bad",
    [
        {"w": 5},  # niedozwolona szerokość
        {"w": 13},
        {"id": ""},
        {"id": "ze spacją"},
        {"id": "x" * 41},
        {"type": "nieznany"},
        {"config": {"y_max": 0}},
        {"config": {"y_max": -5}},
        {"config": {"range_min": 45}},
        {"config": {"refresh_s": 7}},
        {"config": {"chart": "kołowy"}},
        {"config": {"unit": "megabits"}},
        {"config": {"height": "xl"}},
        {"config": {"series": []}},
        {"config": {"series": [{"key": "in_bps", "color": 5}]}},
        {"config": {"source": {"kind": "interface"}}},  # brak id
        {"config": {"source": {"kind": "interface", "id": 0}}},
        {"config": {"source": {"kind": "nieznane"}}},
    ],
)
def test_rejects_invalid_chart_widget(bad):
    with pytest.raises(ValidationError):
        DashboardLayout.model_validate(layout(chart(**bad)))


def test_rejects_too_long_title_and_trims_blank():
    with pytest.raises(ValidationError):
        ChartConfig.model_validate({"title": "x" * 81, "source": {"kind": "wan"}, "series": [{"key": "in_bps"}]})
    c = ChartConfig.model_validate({"title": "  Ruch  ", "source": {"kind": "wan"}, "series": [{"key": "in_bps"}]})
    assert c.title == "Ruch"
    assert ChartConfig.model_validate({"title": "   ", "source": {"kind": "wan"}, "series": [{"key": "in_bps"}]}).title is None


def test_widget_limits_and_unique_ids():
    many = [chart(id=f"w{i}") for i in range(MAX_WIDGETS)]
    DashboardLayout.model_validate(layout(*many))
    with pytest.raises(ValidationError):
        DashboardLayout.model_validate(layout(*many, chart(id="za-duzo")))
    with pytest.raises(ValidationError, match="unikalne"):
        DashboardLayout.model_validate(layout(chart(id="a"), chart(id="a")))


def test_summary_tiles_rules():
    with pytest.raises(ValidationError):
        DashboardLayout.model_validate(layout({"id": "s", "type": "summary", "w": 12, "config": {"tiles": []}}))
    with pytest.raises(ValidationError, match="nie mogą się powtarzać"):
        DashboardLayout.model_validate(layout({"id": "s", "type": "summary", "w": 12, "config": {"tiles": ["devices", "devices"]}}))
    with pytest.raises(ValidationError):
        DashboardLayout.model_validate(layout({"id": "s", "type": "summary", "w": 12, "config": {"tiles": ["cos"]}}))


def test_only_schema_version_one_is_accepted():
    with pytest.raises(ValidationError):
        DashboardLayout.model_validate({"version": 2, "widgets": []})
    assert DashboardLayout.model_validate({"widgets": []}).version == 1


def test_roundtrip_is_stable():
    raw = layout(chart(config={"title": "Ruch", "chart": "bar", "unit": "bytes", "smooth": True, "y_max": 100.5, "range_min": 360}))
    parsed = DashboardLayout.model_validate(raw)
    again = DashboardLayout.model_validate(parsed.model_dump(mode="json"))
    assert again == parsed


def test_refresh_prefs():
    assert RefreshPrefs.model_validate({"interval_s": 0, "range_min": 15}).interval_s == 0
    for bad in ({"interval_s": 7, "range_min": 60}, {"interval_s": 30, "range_min": 5}, {"interval_s": 30}):
        with pytest.raises(ValidationError):
            RefreshPrefs.model_validate(bad)


def test_agent_source_needs_key_except_cpu():
    series = [{"key": "rx_bps"}]
    with pytest.raises(ValidationError):
        ChartConfig.model_validate({"source": {"kind": "agent_net", "id": 2, "key": "  "}, "series": series})
    cpu = ChartConfig.model_validate({"source": {"kind": "agent_cpu", "id": 2, "key": "x"}, "series": [{"key": "core_max_percent"}]})
    assert cpu.source.key == ""
    with pytest.raises(ValidationError):  # metryka innego źródła z agenta
        ChartConfig.model_validate({"source": {"kind": "agent_net", "id": 2, "key": "eth0"}, "series": [{"key": "temp_c"}]})
