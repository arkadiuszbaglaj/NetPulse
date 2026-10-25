"""Schemat układu pulpitu (wersja 1) – to samo JSON-owe wejście i wyjście dla panelu, aplikacji mobilnej
i przyszłych pulpitów publicznych. Walidacja jest ścisła (brak nieznanych pól, ograniczone liczby i
długości), bo układ jest danymi od użytkownika zapisywanymi w bazie."""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

SCHEMA_VERSION = 1
MAX_WIDGETS = 40

GridWidth = Literal[3, 4, 6, 8, 12]  # szerokość w kolumnach siatki 12-kolumnowej
RangeMinutes = Literal[15, 60, 360, 1440, 10080]
RefreshSeconds = Literal[0, 5, 10, 30, 60, 300]


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


# --- źródła danych wykresu -----------------------------------------------------------


class WanSource(Strict):
    kind: Literal["wan"]


class WifiTotalSource(Strict):
    kind: Literal["wifi_total"]


class InterfaceSource(Strict):
    kind: Literal["interface"]
    id: int = Field(ge=1)
    device_id: int | None = Field(None, ge=1)  # tylko dla edytora: z którego urządzenia wybrano port


class DeviceSource(Strict):
    kind: Literal["device"]
    id: int = Field(ge=1)


class WifiNetworkSource(Strict):
    kind: Literal["wifi_network"]
    id: int = Field(ge=1)
    device_id: int | None = Field(None, ge=1)  # tylko dla edytora: z którego urządzenia wybrano sieć


class ServerSource(Strict):
    kind: Literal["server"]  # serwer, na którym działa NetPulse


class AgentSource(Strict):
    """Dane z agenta serwera (tabela `metrics`): CPU na rdzeniach, sieć, dysk, czujnik albo kontener."""

    kind: Literal["agent_cpu", "agent_net", "agent_disk", "agent_temp", "agent_container", "pve_guest"]
    id: int = Field(ge=1)  # urządzenie (serwer z agentem albo węzeł Proxmox)
    key: str = Field("", max_length=255)  # interfejs, dysk, czujnik albo kontener; dla agent_cpu puste

    @model_validator(mode="after")
    def _key_required(self) -> AgentSource:
        self.key = self.key.strip()
        if self.kind != "agent_cpu" and not self.key:
            raise ValueError("Wybierz interfejs, dysk, czujnik, kontener albo maszynę")
        if self.kind == "agent_cpu":
            self.key = ""
        return self


Source = Annotated[
    WanSource | WifiTotalSource | InterfaceSource | DeviceSource | WifiNetworkSource | ServerSource | AgentSource,
    Field(discriminator="kind"),
]

# Metryki dostępne dla źródła (klucze z odpowiedzi endpointów metryk)
ALLOWED_METRICS: dict[str, tuple[str, ...]] = {
    "wan": ("in_bps", "out_bps"),
    "interface": ("in_bps", "out_bps", "in_errors", "out_errors", "in_discards", "out_discards"),
    "device": ("cpu_percent", "mem_used_percent", "load1", "poll_ms"),
    "wifi_total": ("clients",),
    "wifi_network": ("clients", "rx_bps", "tx_bps"),
    "server": ("cpu_percent", "mem_used_percent", "swap_used_percent", "disk_used_percent", "load1", "temp_c", "db_size_bytes"),
    "agent_cpu": ("core_max_percent", "core_avg_percent"),
    "agent_net": ("rx_bps", "tx_bps"),
    "agent_disk": ("read_bps", "write_bps"),
    "agent_temp": ("temp_c",),
    "agent_container": ("container_cpu_percent", "container_mem_bytes"),
    "pve_guest": ("guest_cpu_percent", "guest_mem_bytes", "rx_bps", "tx_bps", "read_bps", "write_bps"),
}


class SeriesConfig(Strict):
    key: str = Field(max_length=32)
    color: Literal[1, 2, 3, 4] | None = None  # numer koloru z palety motywu; puste = kolejny
    label: str | None = Field(None, max_length=40)


class ChartConfig(Strict):
    title: str | None = Field(None, max_length=80)
    source: Source
    series: list[SeriesConfig] = Field(min_length=1, max_length=6)
    chart: Literal["line", "area", "bar"] = "area"
    unit: Literal["bits", "bytes"] = "bits"  # dla metryk przepustowości: bit/s albo bajty/s
    smooth: bool = False
    y_max: float | None = Field(None, gt=0, le=1e15)
    range_min: RangeMinutes | None = None  # puste = zakres globalny
    refresh_s: RefreshSeconds | None = None  # puste = interwał globalny
    height: Literal["sm", "md", "lg"] = "md"

    @field_validator("title")
    @classmethod
    def _strip_title(cls, v: str | None) -> str | None:
        v = v.strip() if v else v
        return v or None

    @model_validator(mode="after")
    def _metrics_match_source(self) -> ChartConfig:
        allowed = ALLOWED_METRICS[self.source.kind]
        keys = [s.key for s in self.series]
        bad = [k for k in keys if k not in allowed]
        if bad:
            raise ValueError(f"Metryka {bad[0]!r} nie jest dostępna dla źródła {self.source.kind!r}")
        if len(set(keys)) != len(keys):
            raise ValueError("Metryki w wykresie nie mogą się powtarzać")
        return self


# --- widgety -------------------------------------------------------------------------

WIDGET_ID = r"^[A-Za-z0-9_-]{1,40}$"


class SummaryConfig(Strict):
    tiles: list[Literal["devices", "wan_down", "wan_up", "wifi_clients"]] = Field(min_length=1, max_length=4)

    @field_validator("tiles")
    @classmethod
    def _unique(cls, v: list[str]) -> list[str]:
        if len(set(v)) != len(v):
            raise ValueError("Kafelki nie mogą się powtarzać")
        return v


class DevicesConfig(Strict):
    kinds: list[Literal["gateway", "switch", "ap", "server", "other"]] | None = Field(None, max_length=4)  # puste = wszystkie


class ServerConfig(Strict):
    pass  # karta stanu serwera NetPulse nie ma ustawień


class PoeConfig(Strict):
    device_id: int | None = Field(None, ge=1)  # puste = wszystkie switche z danymi PoE


class SummaryWidget(Strict):
    id: str = Field(pattern=WIDGET_ID)
    type: Literal["summary"]
    w: GridWidth
    config: SummaryConfig


class ChartWidget(Strict):
    id: str = Field(pattern=WIDGET_ID)
    type: Literal["chart"]
    w: GridWidth
    config: ChartConfig


class DevicesWidget(Strict):
    id: str = Field(pattern=WIDGET_ID)
    type: Literal["devices"]
    w: GridWidth
    config: DevicesConfig = DevicesConfig()


class PoeWidget(Strict):
    id: str = Field(pattern=WIDGET_ID)
    type: Literal["poe"]
    w: GridWidth
    config: PoeConfig = PoeConfig()


class ServerWidget(Strict):
    id: str = Field(pattern=WIDGET_ID)
    type: Literal["server"]
    w: GridWidth
    config: ServerConfig = ServerConfig()


Widget = Annotated[
    SummaryWidget | ChartWidget | DevicesWidget | PoeWidget | ServerWidget, Field(discriminator="type")
]


class DashboardLayout(Strict):
    version: Literal[1] = SCHEMA_VERSION
    widgets: list[Widget] = Field(max_length=MAX_WIDGETS)

    @field_validator("widgets")
    @classmethod
    def _unique_ids(cls, v: list) -> list:
        ids = [w.id for w in v]
        if len(set(ids)) != len(ids):
            raise ValueError("Identyfikatory widgetów muszą być unikalne")
        return v


# --- preferencje (odświeżanie) -------------------------------------------------------


class RefreshPrefs(Strict):
    interval_s: RefreshSeconds
    range_min: RangeMinutes
