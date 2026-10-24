"""Data model.

Regular tables: devices, interfaces.
TimescaleDB hypertables (time series): interface_metrics, device_metrics.
The hypertables, compression and retention policies are created in the Alembic migration.
"""

from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    Double,
    ForeignKey,
    Integer,
    SmallInteger,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


class Device(Base):
    __tablename__ = "devices"
    __table_args__ = (
        CheckConstraint("snmp_version IN ('v1', 'v2c', 'v3')", name="snmp_version_valid"),
        CheckConstraint(
            "snmp_auth_protocol IS NULL OR snmp_auth_protocol IN "
            "('MD5', 'SHA', 'SHA224', 'SHA256', 'SHA384', 'SHA512')",
            name="snmp_auth_protocol_valid",
        ),
        CheckConstraint(
            "snmp_priv_protocol IS NULL OR snmp_priv_protocol IN "
            "('DES', '3DES', 'AES128', 'AES192', 'AES256')",
            name="snmp_priv_protocol_valid",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(100))
    host: Mapped[str] = mapped_column(String(255), unique=True)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")

    # SNMP access. v1/v2c use `snmp_community`; v3 uses the USM fields below.
    # The v3 security level follows from which protocols are set:
    # none -> noAuthNoPriv, auth only -> authNoPriv, auth + priv -> authPriv.
    snmp_version: Mapped[str] = mapped_column(String(3), default="v2c", server_default="v2c")
    snmp_port: Mapped[int] = mapped_column(Integer, default=161, server_default="161")
    snmp_community: Mapped[str | None] = mapped_column(String(255))
    snmp_username: Mapped[str | None] = mapped_column(String(255))
    snmp_auth_protocol: Mapped[str | None] = mapped_column(String(10))
    snmp_auth_password: Mapped[str | None] = mapped_column(String(255))
    snmp_priv_protocol: Mapped[str | None] = mapped_column(String(10))
    snmp_priv_password: Mapped[str | None] = mapped_column(String(255))
    snmp_context: Mapped[str | None] = mapped_column(String(255))

    # Filled in by discovery (sysObjectID / sysDescr pick the driver).
    driver: Mapped[str | None] = mapped_column(String(50))
    vendor: Mapped[str | None] = mapped_column(String(50))
    model: Mapped[str | None] = mapped_column(String(100))
    sys_object_id: Mapped[str | None] = mapped_column(String(255))
    sys_descr: Mapped[str | None] = mapped_column(Text)
    sys_name: Mapped[str | None] = mapped_column(String(255))
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    interfaces: Mapped[list["Interface"]] = relationship(
        back_populates="device", cascade="all, delete-orphan", passive_deletes=True
    )


class Interface(Base):
    __tablename__ = "interfaces"
    __table_args__ = (UniqueConstraint("device_id", "if_index"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    device_id: Mapped[int] = mapped_column(ForeignKey("devices.id", ondelete="CASCADE"))
    if_index: Mapped[int] = mapped_column(Integer)

    name: Mapped[str | None] = mapped_column(String(255))  # ifName
    descr: Mapped[str | None] = mapped_column(String(255))  # ifDescr
    alias: Mapped[str | None] = mapped_column(String(255))  # ifAlias (UniFi port names)
    if_type: Mapped[int | None] = mapped_column(Integer)  # IANAifType
    mac: Mapped[str | None] = mapped_column(String(17))
    speed_mbps: Mapped[int | None] = mapped_column(BigInteger)  # ifHighSpeed
    admin_status: Mapped[int | None] = mapped_column(SmallInteger)  # 1 up, 2 down, 3 testing
    oper_status: Mapped[int | None] = mapped_column(SmallInteger)  # 1 up, 2 down, ... 7

    # Set by the driver: e.g. wan, lan, uplink, radio, ssid, virtual.
    role: Mapped[str | None] = mapped_column(String(20))
    hidden: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    device: Mapped[Device] = relationship(back_populates="interfaces")


class InterfaceMetric(Base):
    """One sample per interface per poll. Rates are computed by the collector from
    counter deltas (Counter32 wrap and device reboot handled there)."""

    __tablename__ = "interface_metrics"

    time: Mapped[datetime] = mapped_column(DateTime(timezone=True), primary_key=True)
    interface_id: Mapped[int] = mapped_column(
        ForeignKey("interfaces.id", ondelete="CASCADE"), primary_key=True
    )
    in_bps: Mapped[float | None] = mapped_column(Double)
    out_bps: Mapped[float | None] = mapped_column(Double)
    in_errors: Mapped[int | None] = mapped_column(BigInteger)  # delta since previous sample
    out_errors: Mapped[int | None] = mapped_column(BigInteger)
    in_discards: Mapped[int | None] = mapped_column(BigInteger)
    out_discards: Mapped[int | None] = mapped_column(BigInteger)
    oper_status: Mapped[int | None] = mapped_column(SmallInteger)


class DeviceMetric(Base):
    __tablename__ = "device_metrics"

    time: Mapped[datetime] = mapped_column(DateTime(timezone=True), primary_key=True)
    device_id: Mapped[int] = mapped_column(
        ForeignKey("devices.id", ondelete="CASCADE"), primary_key=True
    )
    reachable: Mapped[bool] = mapped_column(Boolean)
    response_ms: Mapped[float | None] = mapped_column(Double)
    uptime_s: Mapped[int | None] = mapped_column(BigInteger)
    load_1m: Mapped[float | None] = mapped_column(Double)
    mem_total_kb: Mapped[int | None] = mapped_column(BigInteger)
    mem_available_kb: Mapped[int | None] = mapped_column(BigInteger)
