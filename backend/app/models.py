from datetime import datetime

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Integer, String, Table, Text, Column, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base, DiagramsBase

computer_tags = Table(
    "computer_tags",
    Base.metadata,
    Column("computer_id", Integer, ForeignKey("computers.id", ondelete="CASCADE"), primary_key=True),
    Column("tag_id", Integer, ForeignKey("tags.id", ondelete="CASCADE"), primary_key=True),
)


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    username: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    email: Mapped[str | None] = mapped_column(String(255), nullable=True)
    hashed_password: Mapped[str] = mapped_column(String(255))
    full_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    avatar_emoji: Mapped[str | None] = mapped_column(String(32), nullable=True)
    avatar_bg: Mapped[str | None] = mapped_column(String(16), nullable=True)
    avatar_data: Mapped[str | None] = mapped_column(Text, nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    is_superuser: Mapped[bool] = mapped_column(Boolean, default=False)
    role: Mapped[str] = mapped_column(String(16), default="observer")
    is_ldap: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Computer(Base):
    __tablename__ = "computers"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    hostname: Mapped[str] = mapped_column(String(255), index=True)
    serial_number: Mapped[str | None] = mapped_column(String(128), nullable=True, index=True)
    mac_primary: Mapped[str | None] = mapped_column(String(32), nullable=True)
    ip_address: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    # Cached ICMP reachability: online | offline | unknown
    ping_status: Mapped[str | None] = mapped_column(String(16), nullable=True, index=True)
    last_ping_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    cpu: Mapped[str | None] = mapped_column(String(512), nullable=True)
    ram_gb: Mapped[float | None] = mapped_column(nullable=True)
    os_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    os_version: Mapped[str | None] = mapped_column(String(255), nullable=True)
    manufacturer: Mapped[str | None] = mapped_column(String(255), nullable=True)
    model: Mapped[str | None] = mapped_column(String(255), nullable=True)
    location: Mapped[str | None] = mapped_column(String(255), nullable=True)
    gpu_name: Mapped[str | None] = mapped_column(String(512), nullable=True)
    memory_used_percent: Mapped[int | None] = mapped_column(Integer, nullable=True)
    motherboard_manufacturer: Mapped[str | None] = mapped_column(String(255), nullable=True)
    motherboard_product: Mapped[str | None] = mapped_column(String(255), nullable=True)
    disks_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    last_report_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    raw_payload: Mapped[str | None] = mapped_column(Text, nullable=True)

    assigned_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    assigned_user: Mapped["User | None"] = relationship("User", foreign_keys=[assigned_user_id])

    software: Mapped[list["InstalledSoftware"]] = relationship(
        "InstalledSoftware", back_populates="computer", cascade="all, delete-orphan"
    )
    peripherals: Mapped[list["Peripheral"]] = relationship(
        "Peripheral", back_populates="computer", cascade="all, delete-orphan"
    )
    tags: Mapped[list["Tag"]] = relationship(
        "Tag", secondary=computer_tags, back_populates="computers"
    )


class InstalledSoftware(Base):
    __tablename__ = "installed_software"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    computer_id: Mapped[int] = mapped_column(ForeignKey("computers.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(512))
    version: Mapped[str | None] = mapped_column(String(255), nullable=True)

    computer: Mapped["Computer"] = relationship("Computer", back_populates="software")


class Peripheral(Base):
    __tablename__ = "peripherals"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    computer_id: Mapped[int] = mapped_column(ForeignKey("computers.id", ondelete="CASCADE"), index=True)
    kind: Mapped[str] = mapped_column(String(32))
    name: Mapped[str] = mapped_column(String(512))

    computer: Mapped["Computer"] = relationship("Computer", back_populates="peripherals")


class Monitor(Base):
    __tablename__ = "monitors"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(255), index=True)
    manufacturer: Mapped[str | None] = mapped_column(String(255), nullable=True)
    model: Mapped[str | None] = mapped_column(String(255), nullable=True)
    serial_number: Mapped[str | None] = mapped_column(String(128), nullable=True, index=True)
    inventory_number: Mapped[str | None] = mapped_column(String(128), nullable=True, index=True)
    organization: Mapped[str | None] = mapped_column(String(255), nullable=True)
    glpi_contact_raw: Mapped[str | None] = mapped_column(String(255), nullable=True)
    glpi_updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    assigned_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True, index=True)
    assigned_user: Mapped["User | None"] = relationship("User", foreign_keys=[assigned_user_id])


class Printer(Base):
    __tablename__ = "printers"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    dedupe_key: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(512), index=True)
    driver_name: Mapped[str | None] = mapped_column(String(512), nullable=True)
    port_name: Mapped[str | None] = mapped_column(String(512), nullable=True)
    ip_address: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    is_network: Mapped[bool] = mapped_column(Boolean, default=False)
    is_shared: Mapped[bool] = mapped_column(Boolean, default=False)
    is_default: Mapped[bool] = mapped_column(Boolean, default=False)
    agent_status: Mapped[str | None] = mapped_column(String(64), nullable=True)
    work_offline: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    poll_status: Mapped[str | None] = mapped_column(String(32), nullable=True)
    computer_id: Mapped[int | None] = mapped_column(ForeignKey("computers.id", ondelete="SET NULL"), nullable=True, index=True)
    location: Mapped[str | None] = mapped_column(String(255), nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    source: Mapped[str] = mapped_column(String(16), default="agent")
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_poll_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    snmp_model: Mapped[str | None] = mapped_column(String(512), nullable=True)
    page_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    supplies_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    last_snmp_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    snmp_status: Mapped[str | None] = mapped_column(String(32), nullable=True)
    snmp_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class Diagram(DiagramsBase):
    __tablename__ = "diagrams"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    title: Mapped[str] = mapped_column(String(255), default="Схема", index=True)
    source_filename: Mapped[str] = mapped_column(String(255), default="")
    source_mime: Mapped[str] = mapped_column(String(128), default="")
    source_bytes: Mapped[bytes] = mapped_column(nullable=False)
    svg_text: Mapped[str] = mapped_column(Text, default="")
    # Порядок этажей в селекторе; планировка (кабинеты + ПК) в координатах SVG (как viewBox импорта).
    sort_order: Mapped[int] = mapped_column(Integer, default=0, index=True)
    floor_layout_json: Mapped[str] = mapped_column(Text, default="{}")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    bindings: Mapped[list["DiagramBinding"]] = relationship(
        "DiagramBinding", back_populates="diagram", cascade="all, delete-orphan"
    )


class DiagramBinding(DiagramsBase):
    __tablename__ = "diagram_bindings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    diagram_id: Mapped[int] = mapped_column(ForeignKey("diagrams.id", ondelete="CASCADE"), index=True)
    shape_id: Mapped[str] = mapped_column(String(255), index=True)
    object_type: Mapped[str] = mapped_column(String(32), index=True)  # tag|user|computer|monitor|request
    object_id: Mapped[int] = mapped_column(Integer, index=True)
    label: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    diagram: Mapped["Diagram"] = relationship("Diagram", back_populates="bindings")


class DiskVolume(Base):
    __tablename__ = "disk_volumes"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    computer_id: Mapped[int] = mapped_column(ForeignKey("computers.id", ondelete="CASCADE"), index=True)
    mount: Mapped[str] = mapped_column(String(32))
    label: Mapped[str | None] = mapped_column(String(255), nullable=True)
    total_gb: Mapped[float | None] = mapped_column(nullable=True)
    used_percent: Mapped[int | None] = mapped_column(Integer, nullable=True)
    free_gb: Mapped[float | None] = mapped_column(nullable=True)


class ServiceRequest(Base):
    __tablename__ = "service_requests"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    ticket_no: Mapped[int | None] = mapped_column(Integer, nullable=True, unique=True, index=True)
    glpi_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    title: Mapped[str] = mapped_column(String(255))
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String(32), default="open")
    priority: Mapped[str] = mapped_column(String(32), default="normal")
    glpi_status: Mapped[str | None] = mapped_column(String(64), nullable=True)
    glpi_priority: Mapped[str | None] = mapped_column(String(64), nullable=True)
    glpi_updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    external_source: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
    external_id: Mapped[str | None] = mapped_column(String(128), nullable=True, index=True)
    external_url: Mapped[str | None] = mapped_column(String(512), nullable=True)
    external_payload_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    requester_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    category: Mapped[str | None] = mapped_column(String(255), nullable=True)
    location: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_by_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    computer_id: Mapped[int | None] = mapped_column(ForeignKey("computers.id"), nullable=True)
    opened_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    planned_close_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class AssetChangeLog(Base):
    __tablename__ = "asset_change_logs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    computer_id: Mapped[int] = mapped_column(ForeignKey("computers.id", ondelete="CASCADE"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    source: Mapped[str] = mapped_column(String(32), default="agent")
    kind: Mapped[str] = mapped_column(String(64))
    field_key: Mapped[str | None] = mapped_column(String(64), nullable=True)
    old_value: Mapped[str | None] = mapped_column(Text, nullable=True)
    new_value: Mapped[str | None] = mapped_column(Text, nullable=True)
    payload_json: Mapped[str | None] = mapped_column(Text, nullable=True)


service_request_assignees = Table(
    "service_request_assignees",
    Base.metadata,
    Column("request_id", Integer, ForeignKey("service_requests.id", ondelete="CASCADE"), primary_key=True),
    Column("user_id", Integer, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
)


service_request_template_assignees = Table(
    "service_request_template_assignees",
    Base.metadata,
    Column(
        "template_id",
        Integer,
        ForeignKey("service_request_templates.id", ondelete="CASCADE"),
        primary_key=True,
    ),
    Column("user_id", Integer, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
)


class ServiceRequestTemplate(Base):
    __tablename__ = "service_request_templates"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    title: Mapped[str] = mapped_column(String(255))
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String(32), default="open")
    priority: Mapped[str] = mapped_column(String(32), default="normal")
    requester_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    category: Mapped[str | None] = mapped_column(String(255), nullable=True)
    computer_id: Mapped[int | None] = mapped_column(ForeignKey("computers.id"), nullable=True)
    opened_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    planned_close_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_by_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class AgentToken(Base):
    __tablename__ = "agent_tokens"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    public_id_prefix: Mapped[str] = mapped_column(String(32), index=True)
    token_hash: Mapped[str] = mapped_column(String(255))
    label: Mapped[str | None] = mapped_column(String(255), nullable=True)
    allowed_hostname: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class Tag(Base):
    __tablename__ = "tags"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    color: Mapped[str | None] = mapped_column(String(16), nullable=True)

    computers: Mapped[list["Computer"]] = relationship(
        "Computer", secondary=computer_tags, back_populates="tags"
    )


class ServiceRequestCategory(Base):
    """Дерево категорий заявок: группа → подгруппы (полный путь собирается при отдаче API)."""

    __tablename__ = "service_request_categories"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    parent_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("service_request_categories.id", ondelete="CASCADE"), nullable=True, index=True
    )
    name: Mapped[str] = mapped_column(String(128), index=True)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)

    parent: Mapped["ServiceRequestCategory | None"] = relationship(
        "ServiceRequestCategory", remote_side="ServiceRequestCategory.id", back_populates="children"
    )
    children: Mapped[list["ServiceRequestCategory"]] = relationship(
        "ServiceRequestCategory", back_populates="parent", cascade="all, delete-orphan"
    )


class LdapConfig(Base):
    __tablename__ = "ldap_config"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    allow_anonymous: Mapped[bool] = mapped_column(Boolean, default=False)
    uri: Mapped[str] = mapped_column(String(512), default="")
    bind_dn: Mapped[str] = mapped_column(String(512), default="")
    bind_password: Mapped[str] = mapped_column(String(512), default="")
    user_search_base: Mapped[str] = mapped_column(String(512), default="")
    user_filter: Mapped[str] = mapped_column(
        String(512),
        default="(&(objectClass=user)(objectCategory=person))",
    )
    username_attr: Mapped[str] = mapped_column(String(128), default="sAMAccountName")
    display_name_attr: Mapped[str] = mapped_column(String(128), default="displayName")
    email_attr: Mapped[str] = mapped_column(String(128), default="mail")
    sync_limit: Mapped[int] = mapped_column(Integer, default=500)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class WikiRagDocument(Base):
    __tablename__ = "wiki_rag_documents"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    original_filename: Mapped[str] = mapped_column(String(512))
    stored_filename: Mapped[str] = mapped_column(String(512), unique=True, index=True)
    mime_type: Mapped[str | None] = mapped_column(String(128), nullable=True)
    size_bytes: Mapped[int] = mapped_column(Integer, default=0)
    comment: Mapped[str | None] = mapped_column(Text, nullable=True)
    uploaded_by_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    uploaded_by: Mapped["User"] = relationship("User", foreign_keys=[uploaded_by_id])


class PrinterPollConfig(Base):
    __tablename__ = "printer_poll_config"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    poll_enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    poll_interval_minutes: Mapped[int] = mapped_column(Integer, default=60)
    snmp_enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    snmp_community: Mapped[str] = mapped_column(String(128), default="public")
    snmp_timeout_seconds: Mapped[float] = mapped_column(Float, default=3.5)
    ping_timeout_ms: Mapped[int] = mapped_column(Integer, default=1200)
    poll_concurrency: Mapped[int] = mapped_column(Integer, default=10)
    last_run_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_run_summary_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class NetworkDevice(Base):
    __tablename__ = "network_devices"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    dedupe_key: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    ip_address: Mapped[str] = mapped_column(String(64), index=True)
    hostname: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)
    sys_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    sys_descr: Mapped[str | None] = mapped_column(Text, nullable=True)
    sys_object_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    device_type: Mapped[str] = mapped_column(String(32), default="unknown", index=True)
    vendor: Mapped[str | None] = mapped_column(String(128), nullable=True)
    location: Mapped[str | None] = mapped_column(String(255), nullable=True)
    snmp_status: Mapped[str | None] = mapped_column(String(32), nullable=True)
    snmp_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    last_snmp_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    interfaces_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    neighbors_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    fdb_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    extras_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    source: Mapped[str] = mapped_column(String(16), default="snmp")
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class NetworkLink(Base):
    __tablename__ = "network_links"
    __table_args__ = (
        UniqueConstraint(
            "from_type",
            "from_id",
            "to_type",
            "to_id",
            "link_type",
            name="uq_network_links_pair_type",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    from_type: Mapped[str] = mapped_column(String(32), index=True)
    from_id: Mapped[int] = mapped_column(Integer, index=True)
    to_type: Mapped[str] = mapped_column(String(32), index=True)
    to_id: Mapped[int] = mapped_column(Integer, index=True)
    link_type: Mapped[str] = mapped_column(String(32), default="lldp", index=True)
    local_port: Mapped[str | None] = mapped_column(String(128), nullable=True)
    remote_port: Mapped[str | None] = mapped_column(String(128), nullable=True)
    confidence: Mapped[float] = mapped_column(Float, default=1.0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class NetworkPollConfig(Base):
    __tablename__ = "network_poll_config"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    poll_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    poll_interval_minutes: Mapped[int] = mapped_column(Integer, default=120)
    snmp_community: Mapped[str] = mapped_column(String(128), default="public")
    snmp_timeout_seconds: Mapped[float] = mapped_column(Float, default=3.5)
    poll_concurrency: Mapped[int] = mapped_column(Integer, default=8)
    cidr_list_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    last_run_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_run_summary_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class Bitrix24Config(Base):
    __tablename__ = "bitrix24_config"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    incoming_secret: Mapped[str] = mapped_column(String(255), default="")
    default_priority: Mapped[str] = mapped_column(String(32), default="normal")
    default_category: Mapped[str] = mapped_column(String(255), default="bitrix24")
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class WakeOnLanConfig(Base):
    """Panel WoL: off by default; only allowlisted computer IDs can be woken."""

    __tablename__ = "wake_on_lan_config"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    # JSON list of computer ids, e.g. [1, 5]. Empty = nobody (even if enabled).
    allowlist_computer_ids_json: Mapped[str] = mapped_column(Text, default="[]")
    # JSON list of user ids allowed to wake (superuser always may). Empty = only superuser.
    wake_user_ids_json: Mapped[str] = mapped_column(Text, default="[]")
    cooldown_seconds: Mapped[int] = mapped_column(Integer, default=120)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
