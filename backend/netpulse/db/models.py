"""Modele bazy danych (SQLAlchemy 2).

Tabele konfiguracyjne: devices, interfaces, wifi_networks.
Kontrolery UniFi: controllers, network_clients, topology_links. Konta: users, auth_sessions. Ustawienia konta: dashboards (układ pulpitu), user_preferences.
Tabele metryk (TimescaleDB hypertables): interface_metrics, device_metrics, wifi_metrics,
poe_port_metrics, poe_budget_metrics.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


class Device(Base):
    __tablename__ = "devices"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(128))
    host: Mapped[str] = mapped_column(String(255), unique=True)
    port: Mapped[int] = mapped_column(Integer, default=161)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    driver: Mapped[str] = mapped_column(String(32), default="auto")

    # SNMP – v1/v2c
    snmp_version: Mapped[str] = mapped_column(String(4), default="2c")
    community: Mapped[str | None] = mapped_column(String(255), default="public")
    # SNMP – v3
    v3_username: Mapped[str | None] = mapped_column(String(128))
    v3_auth_protocol: Mapped[str | None] = mapped_column(String(16))
    v3_auth_key: Mapped[str | None] = mapped_column(String(255))
    v3_priv_protocol: Mapped[str | None] = mapped_column(String(16))
    v3_priv_key: Mapped[str | None] = mapped_column(String(255))
    v3_context: Mapped[str | None] = mapped_column(String(128))

    # Wykryte przy odpytywaniu
    detected_driver: Mapped[str | None] = mapped_column(String(32))
    kind: Mapped[str] = mapped_column(String(16), default="other")
    vendor: Mapped[str | None] = mapped_column(String(64))
    model: Mapped[str | None] = mapped_column(String(64))
    firmware: Mapped[str | None] = mapped_column(String(64))
    sys_name: Mapped[str | None] = mapped_column(String(255))
    sys_descr: Mapped[str | None] = mapped_column(Text)
    sys_object_id: Mapped[str | None] = mapped_column(String(255))
    uptime_s: Mapped[float | None] = mapped_column(Float)

    status: Mapped[str] = mapped_column(String(16), default="unknown")  # up | down | unknown
    last_polled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_ok_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    interfaces: Mapped[list[Interface]] = relationship(
        back_populates="device", cascade="all, delete-orphan", passive_deletes=True
    )
    wifi_networks: Mapped[list[WifiNetwork]] = relationship(
        back_populates="device", cascade="all, delete-orphan", passive_deletes=True
    )


class Interface(Base):
    __tablename__ = "interfaces"
    __table_args__ = (UniqueConstraint("device_id", "if_index"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    device_id: Mapped[int] = mapped_column(ForeignKey("devices.id", ondelete="CASCADE"), index=True)
    if_index: Mapped[int] = mapped_column(Integer)
    name: Mapped[str] = mapped_column(String(128))
    descr: Mapped[str | None] = mapped_column(String(255))
    alias: Mapped[str | None] = mapped_column(String(255))
    label: Mapped[str] = mapped_column(String(128), default="")
    if_type: Mapped[int | None] = mapped_column(Integer)
    mac: Mapped[str | None] = mapped_column(String(17))
    role: Mapped[str] = mapped_column(String(16), default="port")
    hidden: Mapped[bool] = mapped_column(Boolean, default=False)
    admin_up: Mapped[bool | None] = mapped_column(Boolean)
    oper_status: Mapped[str] = mapped_column(String(16), default="unknown")
    speed_mbps: Mapped[int | None] = mapped_column(Integer)
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    device: Mapped[Device] = relationship(back_populates="interfaces")


class WifiNetwork(Base):
    __tablename__ = "wifi_networks"
    __table_args__ = (UniqueConstraint("device_id", "key"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    device_id: Mapped[int] = mapped_column(ForeignKey("devices.id", ondelete="CASCADE"), index=True)
    key: Mapped[str] = mapped_column(String(64))
    ssid: Mapped[str] = mapped_column(String(64))
    radio: Mapped[str | None] = mapped_column(String(16))
    channel: Mapped[int | None] = mapped_column(Integer)
    bssid: Mapped[str | None] = mapped_column(String(17))
    hidden: Mapped[bool] = mapped_column(Boolean, default=False)
    clients: Mapped[int | None] = mapped_column(Integer)
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    device: Mapped[Device] = relationship(back_populates="wifi_networks")


# --- konta ------------------------------------------------------------------


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    username: Mapped[str] = mapped_column(String(64), unique=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    is_admin: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class AuthSession(Base):
    """Sesja logowania. W bazie tylko skrót SHA-256 tokenu z ciasteczka."""

    __tablename__ = "auth_sessions"

    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    ip: Mapped[str | None] = mapped_column(String(64))
    user_agent: Mapped[str | None] = mapped_column(String(255))


class Dashboard(Base):
    """Układ pulpitu: wersjonowany JSON z widgetami (schemat: api/layout_schemas.py).

    Na razie każdy użytkownik ma jeden pulpit domyślny; tabela jest gotowa na wiele pulpitów."""

    __tablename__ = "dashboards"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    owner_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(80), default="Mój pulpit")
    is_default: Mapped[bool] = mapped_column(Boolean, default=True)
    schema_version: Mapped[int] = mapped_column(Integer, default=1)
    layout: Mapped[dict] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class UserPreference(Base):
    """Drobne ustawienia konta (np. odświeżanie) jako JSON, jedna sekcja = jeden klucz."""

    __tablename__ = "user_preferences"

    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    data: Mapped[dict] = mapped_column(JSONB, default=dict)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class AppSetting(Base):
    """Ustawienia całej instalacji (nie konta), np. automatyczne sprawdzanie aktualizacji. Jeden klucz = jeden JSON."""

    __tablename__ = "app_settings"

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[dict] = mapped_column(JSONB, default=dict)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


# --- metryki (hypertables) --------------------------------------------------


class InterfaceMetric(Base):
    __tablename__ = "interface_metrics"

    time: Mapped[datetime] = mapped_column(DateTime(timezone=True), primary_key=True)
    interface_id: Mapped[int] = mapped_column(
        ForeignKey("interfaces.id", ondelete="CASCADE"), primary_key=True
    )
    in_bps: Mapped[float | None] = mapped_column(Float)
    out_bps: Mapped[float | None] = mapped_column(Float)
    in_errors: Mapped[int | None] = mapped_column(BigInteger)
    out_errors: Mapped[int | None] = mapped_column(BigInteger)
    in_discards: Mapped[int | None] = mapped_column(BigInteger)
    out_discards: Mapped[int | None] = mapped_column(BigInteger)
    oper_up: Mapped[bool | None] = mapped_column(Boolean)


class DeviceMetric(Base):
    __tablename__ = "device_metrics"

    time: Mapped[datetime] = mapped_column(DateTime(timezone=True), primary_key=True)
    device_id: Mapped[int] = mapped_column(
        ForeignKey("devices.id", ondelete="CASCADE"), primary_key=True
    )
    reachable: Mapped[bool] = mapped_column(Boolean)
    poll_ms: Mapped[float | None] = mapped_column(Float)
    uptime_s: Mapped[float | None] = mapped_column(Float)
    cpu_percent: Mapped[float | None] = mapped_column(Float)
    mem_used_percent: Mapped[float | None] = mapped_column(Float)
    load1: Mapped[float | None] = mapped_column(Float)


class WifiMetric(Base):
    __tablename__ = "wifi_metrics"

    time: Mapped[datetime] = mapped_column(DateTime(timezone=True), primary_key=True)
    wifi_id: Mapped[int] = mapped_column(
        ForeignKey("wifi_networks.id", ondelete="CASCADE"), primary_key=True
    )
    clients: Mapped[int | None] = mapped_column(Integer)
    rx_bps: Mapped[float | None] = mapped_column(Float)
    tx_bps: Mapped[float | None] = mapped_column(Float)


class Controller(Base):
    """Kontroler UniFi Network (API z kluczem): PoE na portach i klienci sieci, których SNMP nie podaje."""

    __tablename__ = "controllers"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(128))
    host: Mapped[str] = mapped_column(String(255), unique=True)
    port: Mapped[int] = mapped_column(Integer, default=443)
    api_key: Mapped[str] = mapped_column(String(255))
    site: Mapped[str] = mapped_column(String(64), default="default")
    verify_tls: Mapped[bool] = mapped_column(Boolean, default=False)  # kontrolery mają zwykle certyfikat samopodpisany
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    app_version: Mapped[str | None] = mapped_column(String(32))
    status: Mapped[str] = mapped_column(String(16), default="unknown")  # up | down | unknown
    last_polled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_ok_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class NetworkClient(Base):
    """Klient sieci (WiFi albo po kablu) widziany przez kontroler; zdjęcie stanu z ostatniego odczytu."""

    __tablename__ = "network_clients"

    controller_id: Mapped[int] = mapped_column(ForeignKey("controllers.id", ondelete="CASCADE"), primary_key=True)
    mac: Mapped[str] = mapped_column(String(17), primary_key=True)
    name: Mapped[str | None] = mapped_column(String(255))
    ip: Mapped[str | None] = mapped_column(String(45))
    is_wired: Mapped[bool] = mapped_column(Boolean, default=False)
    is_guest: Mapped[bool] = mapped_column(Boolean, default=False)
    essid: Mapped[str | None] = mapped_column(String(64))
    radio: Mapped[str | None] = mapped_column(String(8))
    signal_dbm: Mapped[int | None] = mapped_column(Integer)
    tx_rate_kbps: Mapped[int | None] = mapped_column(Integer)
    rx_rate_kbps: Mapped[int | None] = mapped_column(Integer)
    # Urządzenie NetPulse (AP albo switch), do którego klient jest podłączony, i jego port
    uplink_device_id: Mapped[int | None] = mapped_column(ForeignKey("devices.id", ondelete="SET NULL"), index=True)
    uplink_name: Mapped[str | None] = mapped_column(String(128))
    uplink_port: Mapped[int | None] = mapped_column(Integer)
    connected_s: Mapped[int | None] = mapped_column(Integer)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class TopologyLink(Base):
    """Połączenie z tabeli LLDP urządzenia: port lokalny → sąsiad (zdjęcie stanu z ostatniego odczytu)."""

    __tablename__ = "topology_links"

    controller_id: Mapped[int] = mapped_column(ForeignKey("controllers.id", ondelete="CASCADE"), primary_key=True)
    device_id: Mapped[int] = mapped_column(ForeignKey("devices.id", ondelete="CASCADE"), primary_key=True)
    local_port_idx: Mapped[int] = mapped_column(Integer, primary_key=True)
    remote_mac: Mapped[str] = mapped_column(String(17), primary_key=True)
    local_mac: Mapped[str] = mapped_column(String(17))  # MAC urządzenia lokalnego (do rozpoznania sąsiada)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class PoePortMetric(Base):
    """PoE na porcie switcha (moc w W). Tylko porty z PoE; port_idx jak w kontrolerze (1, 2, …)."""

    __tablename__ = "poe_port_metrics"

    time: Mapped[datetime] = mapped_column(DateTime(timezone=True), primary_key=True)
    device_id: Mapped[int] = mapped_column(ForeignKey("devices.id", ondelete="CASCADE"), primary_key=True)
    port_idx: Mapped[int] = mapped_column(Integer, primary_key=True)
    power_w: Mapped[float | None] = mapped_column(Float)
    voltage_v: Mapped[float | None] = mapped_column(Float)
    current_ma: Mapped[float | None] = mapped_column(Float)
    poe_mode: Mapped[str | None] = mapped_column(String(16))  # auto | off | passthrough …
    poe_class: Mapped[str | None] = mapped_column(String(16))
    delivering: Mapped[bool | None] = mapped_column(Boolean)


class PoeBudgetMetric(Base):
    """Zużycie i limit mocy PoE całego switcha."""

    __tablename__ = "poe_budget_metrics"

    time: Mapped[datetime] = mapped_column(DateTime(timezone=True), primary_key=True)
    device_id: Mapped[int] = mapped_column(ForeignKey("devices.id", ondelete="CASCADE"), primary_key=True)
    used_w: Mapped[float | None] = mapped_column(Float)
    max_w: Mapped[float | None] = mapped_column(Float)


HYPERTABLES = ("interface_metrics", "device_metrics", "wifi_metrics", "poe_port_metrics", "poe_budget_metrics")
