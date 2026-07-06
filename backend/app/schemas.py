from datetime import datetime, timezone

import re

from typing import Any

from pydantic import BaseModel, Field, field_serializer, field_validator, model_validator

from app.text_sanitize import deep_strip_nul


class Token(BaseModel):
    access_token: str
    token_type: str = "bearer"


class UserBase(BaseModel):
    username: str = Field(min_length=2, max_length=64)
    email: str | None = None
    full_name: str | None = None


class UserProfilePatch(BaseModel):
    username: str | None = Field(default=None, min_length=2, max_length=64)
    full_name: str | None = None
    email: str | None = None


class UserServiceAccountPatch(UserProfilePatch):
    password: str | None = Field(default=None, min_length=6, max_length=128)


class UserCreate(UserBase):
    password: str = Field(min_length=6, max_length=128)
    is_superuser: bool = False
    role: str = Field(default="observer", pattern="^(observer|editor)$")


class UserOut(UserBase):
    id: int
    is_active: bool
    is_superuser: bool
    is_ldap: bool
    role: str
    created_at: datetime

    model_config = {"from_attributes": True}


class UserDirectoryItem(BaseModel):
    id: int
    username: str
    full_name: str | None = None


_TAG_COLOR_RE = re.compile(r"^#[0-9A-Fa-f]{6}$")


def normalize_tag_color(v: str | None) -> str | None:
    if v is None or (isinstance(v, str) and not v.strip()):
        return None
    s = v.strip()
    if not _TAG_COLOR_RE.match(s):
        raise ValueError("Цвет: формат #RRGGBB")
    return s.lower()


class TagBrief(BaseModel):
    id: int
    name: str
    color: str | None = None

    model_config = {"from_attributes": True}


class TagCreate(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    color: str | None = Field(None, description="#RRGGBB")

    @field_validator("color", mode="before")
    @classmethod
    def _color(cls, v):
        if v is None or v == "":
            return None
        return normalize_tag_color(str(v))


class TagUpdate(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=64)
    color: str | None = Field(None, description="#RRGGBB; null в JSON сбрасывает цвет")

    @field_validator("color", mode="before")
    @classmethod
    def _color_patch(cls, v):
        if v is None:
            return None
        if isinstance(v, str) and not v.strip():
            return None
        return normalize_tag_color(str(v))


class TagOut(TagBrief):
    pass


class RequestCategoryTreeNodeOut(BaseModel):
    id: int
    parent_id: int | None = None
    name: str
    path: str
    sort_order: int = 0
    children: list["RequestCategoryTreeNodeOut"] = Field(default_factory=list)


class RequestCategoryCreate(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    parent_id: int | None = None


class RequestCategoryUpdate(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=128)
    parent_id: int | None = None
    sort_order: int | None = None


class SoftwareItem(BaseModel):
    name: str
    version: str | None = None


class PeripheralItem(BaseModel):
    """Устройства из PnP (классы Keyboard, Mouse, Monitor и т.д.)."""

    kind: str = Field(max_length=32)
    name: str = Field(max_length=512)


class AgentPrinterItem(BaseModel):
    """Очереди печати Windows (Win32_Printer)."""

    name: str = Field(max_length=512)
    driver_name: str | None = Field(default=None, max_length=512)
    port_name: str | None = Field(default=None, max_length=512)
    shared: bool = False
    is_default: bool = False
    is_network: bool | None = None
    ip_address: str | None = Field(default=None, max_length=64)
    status_code: int | None = None
    status_label: str | None = Field(default=None, max_length=64)
    work_offline: bool | None = None


class AgentInventoryReport(BaseModel):
    hostname: str
    serial_number: str | None = None
    mac_primary: str | None = None
    cpu: str | None = None
    ram_gb: float | None = None
    os_name: str | None = None
    os_version: str | None = None
    manufacturer: str | None = None
    model: str | None = None
    location: str | None = None
    gpu_name: str | None = None
    memory_used_percent: int | None = None
    motherboard_manufacturer: str | None = None
    motherboard_product: str | None = None
    disks: list["DiskVolume"] = []
    software: list[SoftwareItem] = []
    peripherals: list[PeripheralItem] = []
    printers: list[AgentPrinterItem] = []
    extended: dict[str, Any] | None = None

    @model_validator(mode="before")
    @classmethod
    def strip_nul_bytes(cls, data: Any) -> Any:
        return deep_strip_nul(data)


class DiskVolume(BaseModel):
    mount: str
    label: str | None = None
    total_gb: float | None = None
    used_percent: int | None = None
    free_gb: float | None = None


class ComputerOut(BaseModel):
    id: int
    hostname: str
    serial_number: str | None
    mac_primary: str | None
    cpu: str | None
    ram_gb: float | None
    os_name: str | None
    os_version: str | None
    manufacturer: str | None
    model: str | None
    location: str | None = None
    gpu_name: str | None = None
    memory_used_percent: int | None = None
    motherboard_manufacturer: str | None = None
    motherboard_product: str | None = None
    disks: list[DiskVolume] = []
    last_report_at: datetime | None
    notes: str | None
    assigned_user_id: int | None
    software_count: int = 0
    peripheral_count: int = 0
    tags: list[TagBrief] = []

    model_config = {"from_attributes": True}

    @field_serializer("last_report_at")
    def _ser_last_report_at(self, v: datetime | None):
        # SQLite often drops tzinfo even with timezone=True.
        # Treat naive timestamps as UTC to prevent a visible shift in UI.
        if v is None:
            return None
        if v.tzinfo is None:
            v = v.replace(tzinfo=timezone.utc)
        iso = v.isoformat()
        return iso.replace("+00:00", "Z")


class ComputerDetail(ComputerOut):
    software: list[SoftwareItem] = []
    peripherals: list[PeripheralItem] = []
    agent_extended: dict[str, Any] | None = None


class ComputerUpdate(BaseModel):
    notes: str | None = None
    location: str | None = None
    assigned_user_id: int | None = None
    tag_ids: list[int] | None = None


class DashboardNameCount(BaseModel):
    name: str
    count: int


class DashboardRamBucket(BaseModel):
    label: str
    count: int


class DashboardPeripheralKind(BaseModel):
    kind: str
    label: str
    pc_count: int


class SoftwareInstallHosts(BaseModel):
    name: str
    hostnames: list[str]


class DashboardSummary(BaseModel):
    computers_total: int
    software_installations_total: int
    software_unique_titles: int
    tags_in_directory: int
    snmp_printers_total: int = 0
    service_requests_total: int = 0
    service_requests_active: int = 0
    service_requests_by_status: list[DashboardNameCount] = []
    by_os: list[DashboardNameCount]
    by_manufacturer: list[DashboardNameCount]
    by_system_model: list[DashboardNameCount]
    ram_buckets: list[DashboardRamBucket]
    top_cpu: list[DashboardNameCount]
    top_software: list[DashboardNameCount]
    top_monitors: list[DashboardNameCount] = []
    peripheral_kinds: list[DashboardPeripheralKind]
    top_peripherals: list[DashboardNameCount]
    top_disk_devices: list["DashboardDiskDeviceRank"] = []
    physical_disks_total: int = 0
    physical_disks_by_media: list[DashboardNameCount] = []
    physical_disks_by_size: list[DashboardRamBucket] = []
    physical_disks_by_variant: list[DashboardNameCount] = []
    top_users: list[DashboardNameCount] = []


class DashboardDiskDeviceRank(BaseModel):
    hostname: str
    avg_used_percent: float
    volume_count: int


class DashboardSegmentComputer(BaseModel):
    id: int
    hostname: str
    os_name: str | None = None
    os_version: str | None = None
    os_summary: str | None = None
    ram_gb: float | None = None
    cpu: str | None = None
    manufacturer: str | None = None
    model: str | None = None
    location: str | None = None
    volumes_summary: str | None = None
    physical_disks_summary: str | None = None


class DashboardSegmentComputers(BaseModel):
    kind: str
    name: str
    chart_title: str | None = None
    total: int
    items: list[DashboardSegmentComputer]


class ServiceRequestCreate(BaseModel):
    title: str = Field(min_length=1, max_length=255)
    description: str | None = None
    status: str = "open"
    priority: str = "normal"
    requester_name: str | None = None
    category: str | None = None
    location: str | None = None
    computer_id: int | None = None
    assignee_ids: list[int] = []
    opened_at: datetime | None = None
    planned_close_at: datetime | None = None
    closed_at: datetime | None = None


class ServiceRequestPatch(BaseModel):
    title: str | None = None
    description: str | None = None
    status: str | None = None
    priority: str | None = None
    requester_name: str | None = None
    category: str | None = None
    location: str | None = None
    computer_id: int | None = None
    assignee_ids: list[int] | None = None
    opened_at: datetime | None = None
    planned_close_at: datetime | None = None
    closed_at: datetime | None = None


class ServiceRequestOut(BaseModel):
    id: int
    ticket_no: int | None = None
    glpi_id: int | None = None
    title: str
    description: str | None
    status: str
    priority: str
    glpi_status: str | None = None
    glpi_priority: str | None = None
    glpi_updated_at: datetime | None = None
    external_source: str | None = None
    external_id: str | None = None
    external_url: str | None = None
    requester_name: str | None = None
    category: str | None = None
    location: str | None = None
    created_by_id: int
    created_by_username: str
    assignee_ids: list[int] = []
    assignee_usernames: list[str] = []
    computer_id: int | None = None
    computer_hostname: str | None = None
    created_at: datetime
    updated_at: datetime
    opened_at: datetime | None = None
    planned_close_at: datetime | None = None
    closed_at: datetime | None = None

    @field_serializer(
        "created_at",
        "updated_at",
        "glpi_updated_at",
        "opened_at",
        "planned_close_at",
        "closed_at",
    )
    def _ser_dt(self, v: datetime | None):
        # SQLite may return naive datetimes even for timezone-aware columns.
        # Treat naive values as UTC so UI does not show shifted hours.
        if v is None:
            return None
        if v.tzinfo is None:
            v = v.replace(tzinfo=timezone.utc)
        return v.isoformat().replace("+00:00", "Z")


class ServiceRequestListResponse(BaseModel):
    items: list[ServiceRequestOut]
    total: int


class ServiceRequestTemplateCreate(BaseModel):
    title: str = Field(min_length=1, max_length=255)
    description: str | None = None
    status: str = "open"
    priority: str = "normal"
    requester_name: str | None = None
    category: str | None = None
    computer_id: int | None = None
    assignee_ids: list[int] = []
    opened_at: datetime | None = None
    planned_close_at: datetime | None = None
    closed_at: datetime | None = None


class ServiceRequestTemplatePatch(BaseModel):
    title: str | None = None
    description: str | None = None
    status: str | None = None
    priority: str | None = None
    requester_name: str | None = None
    category: str | None = None
    computer_id: int | None = None
    assignee_ids: list[int] | None = None
    opened_at: datetime | None = None
    planned_close_at: datetime | None = None
    closed_at: datetime | None = None


class ServiceRequestTemplateOut(BaseModel):
    id: int
    title: str
    description: str | None
    status: str
    priority: str
    requester_name: str | None = None
    category: str | None = None
    computer_id: int | None = None
    assignee_ids: list[int] = []
    assignee_usernames: list[str] = []
    opened_at: datetime | None = None
    planned_close_at: datetime | None = None
    closed_at: datetime | None = None
    created_by_id: int
    created_by_username: str
    created_at: datetime
    updated_at: datetime

    @field_serializer(
        "created_at",
        "updated_at",
        "opened_at",
        "planned_close_at",
        "closed_at",
    )
    def _ser_dt(self, v: datetime | None):
        if v is None:
            return None
        if v.tzinfo is None:
            v = v.replace(tzinfo=timezone.utc)
        return v.isoformat().replace("+00:00", "Z")


class ServiceRequestTemplateListResponse(BaseModel):
    items: list[ServiceRequestTemplateOut]
    total: int


class AgentTokenOut(BaseModel):
    id: int
    public_id_prefix: str
    label: str | None
    allowed_hostname: str | None
    created_at: datetime
    revoked_at: datetime | None
    last_used_at: datetime | None

    model_config = {"from_attributes": True}


class AgentTokenCreate(BaseModel):
    label: str | None = None
    allowed_hostname: str | None = None


class AgentTokenCreated(AgentTokenOut):
    token: str


class AgentBundleModules(BaseModel):
    patches: bool = True
    network: bool = True
    domain_sessions: bool = True
    bitlocker: bool = True
    tpm_secureboot: bool = True
    antivirus: bool = True
    startup: bool = True
    services: bool = True
    storage_health: bool = True
    battery: bool = True
    windows_features: bool = True
    office: bool = True
    usb_history: bool = True
    docker_wsl: bool = True


class AgentBundleSchedule(BaseModel):
    enabled: bool = False
    mode: str = Field(default="WEEKLY", pattern="^(DAILY|WEEKLY|MONTHLY)$")
    time: str = Field(default="09:00", max_length=8)
    weekday: str = Field(default="MON", pattern="^(MON|TUE|WED|THU|FRI|SAT|SUN)$")
    task_name: str = Field(default="CORAX-Agent-v3", max_length=128)


class AgentBundleLanIpOut(BaseModel):
    ip: str | None = None
    candidates: list[str] = []


class AgentBundleCreate(BaseModel):
    server_url: str = Field(min_length=8, max_length=512)
    target: str = Field(default="win10", pattern="^(win10|win7)$")
    profile: str = Field(default="full", pattern="^(full|custom|basic|standard)$")
    modules: AgentBundleModules | None = None
    create_token: bool = True
    token_label: str | None = Field(default=None, max_length=128)
    allowed_hostname: str | None = Field(default=None, max_length=128)
    existing_token: str | None = Field(default=None, max_length=512)
    schedule: AgentBundleSchedule | None = None


class LdapConfigOut(BaseModel):
    enabled: bool
    allow_anonymous: bool
    uri: str
    bind_dn: str
    bind_password_set: bool
    user_search_base: str
    user_filter: str
    username_attr: str
    display_name_attr: str
    email_attr: str
    sync_limit: int


class LdapConfigUpdate(BaseModel):
    enabled: bool | None = None
    allow_anonymous: bool | None = None
    uri: str | None = None
    bind_dn: str | None = None
    bind_password: str | None = Field(
        default=None,
        description="Если null — не менять. Если пустая строка — сбросить пароль.",
    )
    user_search_base: str | None = None
    user_filter: str | None = None
    username_attr: str | None = None
    display_name_attr: str | None = None
    email_attr: str | None = None
    sync_limit: int | None = None


class Bitrix24ConfigOut(BaseModel):
    enabled: bool
    incoming_secret: str
    default_priority: str
    default_category: str


class Bitrix24ConfigUpdate(BaseModel):
    enabled: bool | None = None
    incoming_secret: str | None = None
    default_priority: str | None = None
    default_category: str | None = None


class Bitrix24IncomingRequest(BaseModel):
    """Нормализованный payload для вебхука (можно слать из Битрикс-бота)."""

    title: str | None = None
    text: str | None = None
    description: str | None = None
    requester_name: str | None = None
    location: str | None = None
    category: str | None = None
    priority: str | None = None
    external_id: str | None = None
    external_url: str | None = None


class LdapTestRequest(BaseModel):
    """Проверка без сохранения: если поле не задано — берём из сохранённой конфигурации."""

    allow_anonymous: bool | None = None
    uri: str | None = None
    bind_dn: str | None = None
    bind_password: str | None = None
    user_search_base: str | None = None
    user_filter: str | None = None
    username_attr: str | None = None
    display_name_attr: str | None = None
    email_attr: str | None = None
    probe_username: str | None = Field(default=None, description="Опционально: проверить поиск конкретного логина")


class LdapTestResponse(BaseModel):
    ok: bool
    message: str
    found: int = 0
    sample_dn: str | None = None


class WikiRagDocumentOut(BaseModel):
    id: int
    original_filename: str
    mime_type: str | None
    size_bytes: int
    comment: str | None
    uploaded_by_id: int
    uploaded_by_username: str
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class WikiRagDocumentUpdate(BaseModel):
    comment: str | None = Field(default=None, max_length=4000)


class WikiRagDocumentContentOut(BaseModel):
    id: int
    original_filename: str
    kind: str
    editable: bool
    content: str | None = None
    preview_url: str | None = None
    truncated: bool = False
    hint: str | None = None


class WikiRagDocumentContentUpdate(BaseModel):
    content: str = Field(max_length=2_000_000)


class WikiRagChatMessage(BaseModel):
    role: str = Field(pattern="^(user|assistant)$")
    content: str = Field(max_length=12_000)


class WikiRagChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=8000)
    document_ids: list[int] | None = None
    history: list[WikiRagChatMessage] = Field(default_factory=list)


class WikiRagChatResponse(BaseModel):
    ok: bool
    raw: str | None = None
    parsed: dict | None = None
    model: str | None = None
    error: str | None = None
    meta: dict | None = None


class WikiRagChatPreviewOut(BaseModel):
    mode: str
    documents: list[dict[str, str | int]]
    messages: list[dict[str, str]]
    total_chars: int
    hint: str | None = None


class WikiRagLmStudioStatus(BaseModel):
    ok: bool
    models: list[str] = Field(default_factory=list)
    detail: str | None = None
