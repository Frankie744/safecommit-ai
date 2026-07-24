from __future__ import annotations

import json
from pathlib import Path

from reportlab.lib.colors import HexColor
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen.canvas import Canvas


ROOT = Path(__file__).resolve().parents[1]
EVIDENCE_ROOT = (
    ROOT / "artifacts" / "evidence" / "safecommit-database-local"
)
OUTPUT = (
    ROOT
    / "artifacts"
    / "presentation"
    / "SafeCommit_Championship_Deck_LOCAL_TEST.pdf"
)

W, H = 1280, 720
BG = HexColor("#07111F")
PANEL = HexColor("#10233B")
INK = HexColor("#F4F8FF")
MUTED = HexColor("#94A9C6")
CYAN = HexColor("#27D3FF")
GREEN = HexColor("#42E8A8")
RED = HexColor("#FF5D73")
AMBER = HexColor("#FFB84D")


def register_fonts() -> tuple[str, str]:
    regular = Path(r"C:\Windows\Fonts\segoeui.ttf")
    bold = Path(r"C:\Windows\Fonts\seguisb.ttf")
    if regular.exists() and bold.exists():
        pdfmetrics.registerFont(TTFont("SafeCommit", str(regular)))
        pdfmetrics.registerFont(TTFont("SafeCommitBold", str(bold)))
        return "SafeCommit", "SafeCommitBold"
    return "Helvetica", "Helvetica-Bold"


FONT, BOLD = register_fonts()


def text(
    canvas: Canvas,
    value: str,
    x: float,
    y: float,
    size: float,
    color=INK,
    font: str = FONT,
) -> None:
    canvas.setFont(font, size)
    canvas.setFillColor(color)
    canvas.drawString(x, y, value)


def centered(
    canvas: Canvas,
    value: str,
    x: float,
    y: float,
    size: float,
    color=INK,
    font: str = FONT,
) -> None:
    canvas.setFont(font, size)
    canvas.setFillColor(color)
    canvas.drawCentredString(x, y, value)


def lines(
    canvas: Canvas,
    values: list[str],
    x: float,
    y: float,
    size: float = 25,
    leading: float = 38,
    color=INK,
    bullet=False,
) -> None:
    for index, value in enumerate(values):
        prefix = "-  " if bullet else ""
        text(canvas, prefix + value, x, y - index * leading, size, color)


def panel(canvas: Canvas, x: float, y: float, width: float, height: float) -> None:
    canvas.setFillColor(PANEL)
    canvas.roundRect(x, y, width, height, 18, stroke=0, fill=1)


def header(canvas: Canvas, number: int, title: str, label: str = "LOCAL_TEST") -> None:
    text(canvas, f"{number:02d}", 58, 660, 18, CYAN, BOLD)
    text(canvas, title, 106, 650, 36, INK, BOLD)
    canvas.setFillColor(PANEL)
    canvas.roundRect(1080, 644, 142, 34, 17, stroke=0, fill=1)
    centered(canvas, label, 1151, 654, 14, AMBER, BOLD)


def footer(canvas: Canvas, value: str = "SafeCommit - evidence-bound database safety") -> None:
    canvas.setStrokeColor(HexColor("#24415F"))
    canvas.line(58, 42, 1222, 42)
    text(canvas, value, 58, 20, 12, MUTED)


def new_page(canvas: Canvas) -> None:
    canvas.setFillColor(BG)
    canvas.rect(0, 0, W, H, stroke=0, fill=1)


def finish_page(canvas: Canvas) -> None:
    canvas.showPage()


def build() -> None:
    latest_run = (EVIDENCE_ROOT / "latest-run.txt").read_text(
        encoding="utf-8"
    ).strip()
    if not latest_run.startswith("safecommit-mysql-"):
        raise ValueError("Invalid SafeCommit latest-run pointer")
    evidence = EVIDENCE_ROOT / latest_run / "summary.json"
    summary = json.loads(evidence.read_text(encoding="utf-8"))
    candidates = {item["candidateId"]: item for item in summary["candidates"]}
    safe = candidates["candidate-c-safe"]
    shipped = candidates["candidate-b-shipped-order"]
    aggressive = candidates["candidate-a-aggressive"]

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    canvas = Canvas(str(OUTPUT), pagesize=(W, H))
    canvas.setTitle("SafeCommit Championship Deck - LOCAL_TEST")
    canvas.setAuthor("SafeCommit")
    canvas.setSubject("Evidence-bound safety gate for AI database agents")

    # 1
    new_page(canvas)
    text(canvas, "AN AI DELETED A", 62, 605, 30, MUTED, BOLD)
    text(canvas, "PRODUCTION DATABASE", 62, 548, 54, INK, BOLD)
    text(canvas, "IN", 62, 460, 28, MUTED, BOLD)
    text(canvas, "9", 120, 320, 190, RED, BOLD)
    text(canvas, "SECONDS", 350, 350, 52, RED, BOLD)
    canvas.setStrokeColor(CYAN)
    canvas.setLineWidth(4)
    canvas.line(720, 170, 720, 570)
    text(canvas, "RECOVERY", 780, 500, 28, MUTED, BOLD)
    text(canvas, "60", 770, 320, 150, CYAN, BOLD)
    text(canvas, "HOURS", 990, 350, 45, CYAN, BOLD)
    footer(
        canvas,
        "Source: PocketOS official postmortem, May 11 2026 - pocketos.ai/news/",
    )
    finish_page(canvas)

    # 2
    new_page(canvas)
    header(canvas, 2, "The real problem")
    text(canvas, "VALID SQL", 64, 525, 74, GREEN, BOLD)
    text(canvas, "CAN STILL CREATE", 64, 440, 58, INK, BOLD)
    text(canvas, "AN INVALID BUSINESS.", 64, 350, 68, RED, BOLD)
    lines(
        canvas,
        [
            "Ambiguous intent",
            "Complex enterprise relationships",
            "Execution success != business correctness",
        ],
        730,
        250,
        22,
        54,
        MUTED,
        True,
    )
    footer(canvas)
    finish_page(canvas)

    # 3
    new_page(canvas)
    header(canvas, 3, "SafeCommit")
    text(canvas, "THE COMMIT GATE", 64, 520, 68, CYAN, BOLD)
    text(canvas, "FOR AI DATABASE AGENTS.", 64, 435, 58, INK, BOLD)
    stages = ["Generate", "Shadow Execute", "Prove", "Approve", "Commit"]
    x_positions = [78, 310, 565, 805, 1030]
    for index, (stage, x) in enumerate(zip(stages, x_positions, strict=True)):
        canvas.setFillColor(GREEN if index == 4 else PANEL)
        canvas.circle(x + 66, 220, 44, stroke=0, fill=1)
        centered(canvas, str(index + 1), x + 66, 205, 24, BG, BOLD)
        centered(canvas, stage, x + 66, 138, 21, INK, BOLD)
        if index < len(stages) - 1:
            canvas.setStrokeColor(CYAN)
            canvas.setLineWidth(3)
            canvas.line(x + 112, 220, x_positions[index + 1] + 18, 220)
    footer(canvas)
    finish_page(canvas)

    # 4
    new_page(canvas)
    header(canvas, 4, "Real logistics task")
    panel(canvas, 60, 118, 750, 465)
    text(canvas, '"Merge the duplicate SKU in Los Angeles', 96, 500, 34, INK, BOLD)
    text(canvas, "and release cancelled-order inventory...", 96, 452, 34, INK, BOLD)
    text(canvas, 'without changing:"', 96, 404, 34, INK, BOLD)
    lines(
        canvas,
        [
            "other warehouses or tenants",
            "shipped orders",
            "lots, serials, or expiration dates",
        ],
        112,
        330,
        25,
        54,
        MUTED,
        True,
    )
    text(canvas, "MySQL", 900, 470, 66, CYAN, BOLD)
    text(canvas, "8.0.36", 900, 405, 38, INK, BOLD)
    text(canvas, "OpenBoxes-derived", 900, 290, 25, AMBER, BOLD)
    text(canvas, "executable fixture", 900, 250, 25, AMBER, BOLD)
    text(canvas, "NOT a full deployment", 900, 170, 18, MUTED)
    footer(canvas)
    finish_page(canvas)

    # 5
    new_page(canvas)
    header(canvas, 5, "Sponsor-native architecture", "READY / BLOCKED")
    labels = [
        ("Fireworks", "3 structured plans", RED),
        ("Daytona x3", "unique DB snapshots", RED),
        ("Braintrust", "Dataset + Trace + Eval", RED),
        ("CopilotKit", "evidence-bound HITL", GREEN),
    ]
    x_values = [70, 370, 680, 980]
    for index, ((name, subtitle, color), x) in enumerate(
        zip(labels, x_values, strict=True)
    ):
        panel(canvas, x, 245, 230, 220)
        canvas.setFillColor(color)
        canvas.circle(x + 30, 430, 8, stroke=0, fill=1)
        text(canvas, name, x + 28, 365, 28, INK, BOLD)
        text(canvas, subtitle, x + 28, 315, 16, MUTED)
        text(
            canvas,
            "LOCAL PASS" if color == GREEN else "LIVE BLOCKED",
            x + 28,
            270,
            15,
            color,
            BOLD,
        )
        if index < len(labels) - 1:
            canvas.setStrokeColor(CYAN)
            canvas.setLineWidth(3)
            canvas.line(x + 230, 355, x_values[index + 1], 355)
    text(canvas, "CodeRabbit exact-head review is an optional secondary loop.", 70, 155, 22, MUTED)
    footer(canvas)
    finish_page(canvas)

    # 6
    new_page(canvas)
    header(canvas, 6, "Magic moment")
    panel(canvas, 60, 125, 550, 440)
    panel(canvas, 670, 125, 550, 440)
    text(canvas, "HIGHEST SCORE", 98, 505, 19, RED, BOLD)
    text(canvas, f'{shipped["weightedScore"]:.6f}', 98, 410, 66, INK, BOLD)
    text(canvas, "CANDIDATE B", 98, 350, 26, MUTED, BOLD)
    text(canvas, "REJECTED", 98, 255, 48, RED, BOLD)
    text(canvas, "ProtectedOrderState failed", 98, 205, 21, RED)
    text(canvas, "LOWER SCORE", 708, 505, 19, GREEN, BOLD)
    text(canvas, f'{safe["weightedScore"]:.6f}', 708, 410, 66, INK, BOLD)
    text(canvas, "CANDIDATE C", 708, 350, 26, MUTED, BOLD)
    text(canvas, "ELIGIBLE", 708, 255, 48, GREEN, BOLD)
    text(canvas, "All deterministic hard gates passed", 708, 205, 21, GREEN)
    centered(
        canvas,
        "HIGH SCORE CANNOT COMPENSATE FOR BROKEN BUSINESS STATE.",
        640,
        72,
        23,
        CYAN,
        BOLD,
    )
    finish_page(canvas)

    # 7
    new_page(canvas)
    header(canvas, 7, "What SafeCommit proved")
    metrics = [
        ("3", "plans executed"),
        (str(safe["affectedRows"]), "winner rows changed"),
        ("13/13", "hard gates passed"),
        ("0", "rollback digest drift"),
    ]
    x_values = [70, 370, 670, 970]
    for (value, label), x in zip(metrics, x_values, strict=True):
        text(canvas, value, x, 390, 70, CYAN if value != "0" else GREEN, BOLD)
        text(canvas, label, x, 340, 18, MUTED, BOLD)
    text(canvas, "Before", 88, 220, 18, MUTED, BOLD)
    text(canvas, safe["beforeStateDigest"][:18] + "...", 88, 180, 18, INK)
    text(canvas, "Rollback", 690, 220, 18, MUTED, BOLD)
    text(canvas, safe["rollbackStateDigest"][:18] + "...", 690, 180, 18, INK)
    centered(canvas, "DIGESTS MATCH", 640, 95, 28, GREEN, BOLD)
    footer(canvas, f'Evidence: {summary["runId"]} - LOCAL_TEST')
    finish_page(canvas)

    # 8
    new_page(canvas)
    header(canvas, 8, "Baseline vs SafeCommit", "REMOTE BLOCKED")
    text(canvas, "12", 74, 430, 130, CYAN, BOLD)
    text(canvas, "LOGISTICS CASES DEFINED", 74, 365, 29, INK, BOLD)
    panel(canvas, 600, 180, 610, 340)
    text(canvas, "Braintrust Experiment", 650, 445, 28, INK, BOLD)
    text(canvas, "BLOCKED", 650, 345, 60, RED, BOLD)
    lines(
        canvas,
        [
            "No remote Dataset / Trace / Experiment URL",
            "No Direct vs Gated live metric is claimed",
            "Frontend scores are not experiment evidence",
        ],
        650,
        285,
        18,
        42,
        MUTED,
        True,
    )
    text(canvas, "HONEST NEGATIVE RESULT", 74, 225, 19, AMBER, BOLD)
    text(canvas, "The evaluation contract exists.", 74, 180, 24, INK)
    text(canvas, "The remote experiment does not - yet.", 74, 140, 24, INK)
    footer(canvas)
    finish_page(canvas)

    # 9
    new_page(canvas)
    header(canvas, 9, "Why this can become a product")
    text(canvas, "PROFILE + INVARIANT PACK", 64, 510, 52, CYAN, BOLD)
    text(canvas, "NOT 'SUPPORT EVERY DATABASE'", 64, 440, 43, INK, BOLD)
    roadmap = [
        "Logistics",
        "Multi-tenant SaaS",
        "Financial operations",
        "Cloud migrations",
    ]
    for index, value in enumerate(roadmap):
        y = 320 - index * 65
        text(canvas, f"0{index + 1}", 90, y, 18, CYAN, BOLD)
        text(canvas, value, 150, y - 4, 28, INK, BOLD)
        if index < len(roadmap) - 1:
            canvas.setStrokeColor(HexColor("#24415F"))
            canvas.line(102, y - 25, 102, y - 55)
    footer(canvas)
    finish_page(canvas)

    # 10
    new_page(canvas)
    text(canvas, "LET AI MOVE FAST.", 62, 535, 58, INK, BOLD)
    text(canvas, "MAKE DATA SAFETY", 62, 445, 66, CYAN, BOLD)
    text(canvas, "NON-NEGOTIABLE.", 62, 360, 66, CYAN, BOLD)
    panel(canvas, 780, 155, 430, 405)
    text(canvas, "SafeCommit", 830, 485, 34, INK, BOLD)
    text(canvas, "GitHub", 830, 405, 16, MUTED, BOLD)
    text(canvas, "github.com/Frankie744/safecommit-ai", 830, 370, 16, INK)
    text(canvas, "Public demo", 830, 315, 16, MUTED, BOLD)
    text(canvas, "DEPLOYED - READ ONLY", 830, 280, 18, GREEN, BOLD)
    text(canvas, "frankie744.github.io/safecommit-ai/", 830, 248, 13, INK)
    text(canvas, "Braintrust Experiment", 830, 205, 16, MUTED, BOLD)
    text(canvas, "BLOCKED", 830, 170, 18, RED, BOLD)
    text(canvas, "LIVE_CERTIFIED=NO", 62, 120, 21, AMBER, BOLD)
    footer(canvas, f'MySQL {summary["mysql"]} - {summary["status"]} - {summary["runId"]}')
    finish_page(canvas)

    canvas.save()
    print(OUTPUT)


if __name__ == "__main__":
    build()
