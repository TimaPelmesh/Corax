from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field


class RiskFinding(BaseModel):
    id: str
    computer_id: int
    hostname: str
    category: str
    severity: str
    score: int
    title: str
    description: str
    recommendation: str
    evidence: str | None = None
    status: str = "open"
    action_note: str | None = None


class RiskComputer(BaseModel):
    id: int
    hostname: str
    ip_address: str | None = None
    os_name: str | None = None
    last_report_at: datetime | None = None
    risk_score: int
    level: str
    antivirus_status: str
    finding_count: int
    top_findings: list[RiskFinding] = []


class RiskCategorySummary(BaseModel):
    id: str
    label: str
    risk_points: int
    affected_computers: int
    finding_count: int


class RiskOverview(BaseModel):
    generated_at: datetime
    fleet_health_score: int = Field(ge=0, le=100)
    average_risk_score: float
    computers_total: int
    computers_critical: int
    computers_high: int
    computers_medium: int
    computers_healthy: int
    antivirus_protected: int
    antivirus_attention: int
    antivirus_unknown: int
    findings_total: int
    findings_open: int = 0
    findings_acknowledged: int = 0
    findings_ignored: int = 0
    categories: list[RiskCategorySummary]
    computers: list[RiskComputer]
    findings: list[RiskFinding]


class RiskAiRequest(BaseModel):
    base_url: str | None = Field(default=None, max_length=512)
    model: str | None = Field(default=None, max_length=255)
    response_mode: str = Field(default="fast", pattern="^(fast|detailed)$")
    force: bool = False


class RiskAiInsight(BaseModel):
    generated_at: datetime
    model: str | None = None
    text: str
    cached: bool = False


class RiskHistoryPoint(BaseModel):
    created_at: datetime
    fleet_health_score: int
    average_risk_score: float = 0
    computers_total: int = 0
    computers_critical: int = 0
    computers_high: int = 0
    computers_medium: int = 0
    computers_healthy: int = 0
    findings_open: int = 0


class RiskHistory(BaseModel):
    items: list[RiskHistoryPoint]


class RiskFindingAction(BaseModel):
    finding_id: str = Field(min_length=3, max_length=128)
    status: str = Field(pattern="^(open|acknowledged|ignored)$")
    note: str | None = Field(default=None, max_length=500)


class RiskFindingActionOut(BaseModel):
    ok: bool = True
    finding_id: str
    status: str
