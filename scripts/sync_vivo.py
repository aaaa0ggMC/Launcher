#!/usr/bin/env -S uv run --script
# /// script
# dependencies = ["xlrd>=2.0.1"]
# ///
"""
vivo 运动健康 (Vivo Health) 运动数据提取与同步脚本
======================================================
从 vivo 导出的个人健康 Excel (*.xlsx / *.xls) 中提取运动记录，
自动分类归档为独立的运动记录 JSON 文件，供 YARJ 等平台分析与地图展示。

用法:
    scripts/sync_vivo [input_dir_or_file] [output_dir] [options]

示例:
    scripts/sync_vivo /home/aaaa0ggmc/Pictures/GPS/VivoHealth/CSVs /home/aaaa0ggmc/Pictures/GPS/VivoHealth
"""

import os
import sys
import json
import argparse
from pathlib import Path
from datetime import datetime, timezone
import xlrd

SPORT_TYPE_MAP = {
    1: ("Walking", "户外健走"),
    2: ("Running", "户外跑步"),
    3: ("Cycling", "户外骑行"),
    14: ("Walking", "户外健步"),
    15: ("Hiking", "户外徒步"),
}


def parse_args():
    parser = argparse.ArgumentParser(
        description="vivo 运动健康 Excel 运动记录提取与同步工具",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "input_path",
        nargs="?",
        default="/home/aaaa0ggmc/Pictures/GPS/VivoHealth/CSVs",
        help="包含 vivo 导出的 Excel 目录或单个 Excel 文件路径",
    )
    parser.add_argument(
        "output_dir",
        nargs="?",
        default="/home/aaaa0ggmc/Pictures/GPS/VivoHealth",
        help="产物归档根目录（默认分类输出到 Running/, Walking/ 等）",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="强制覆盖本地已存在的运动 JSON",
    )
    return parser.parse_args()


def find_excel_files(path: Path) -> list[Path]:
    if path.is_file():
        if path.suffix.lower() in [".xlsx", ".xls"]:
            return [path]
        return []
    if path.is_dir():
        files = []
        for f in path.glob("**/*"):
            if f.is_file() and f.suffix.lower() in [".xlsx", ".xls"] and not f.name.startswith("~$"):
                files.append(f)
        return sorted(files)
    return []


def process_excel(excel_path: Path, output_root: Path, force: bool) -> tuple[int, int, list[dict]]:
    try:
        wb = xlrd.open_workbook(str(excel_path))
    except Exception as e:
        print(f"❌ 读取 Excel 失败 [{excel_path.name}]: {e}")
        return 0, 0, []

    if "通用运动记录存储" not in wb.sheet_names():
        print(f"⚠️ 跳过未包含 '通用运动记录存储' 工作表的 Excel: {excel_path.name}")
        return 0, 0, []

    sheet = wb.sheet_by_name("通用运动记录存储")
    if sheet.nrows <= 1:
        print(f"⚠️ 工作表为空: {excel_path.name}")
        return 0, 0, []

    headers = [str(sheet.cell_value(0, c)).strip() for c in range(sheet.ncols)]
    
    extracted_count = 0
    skipped_count = 0
    records_summary = []

    for r in range(1, sheet.nrows):
        row = {
            headers[c]: sheet.cell_value(r, c)
            for c in range(sheet.ncols)
            if sheet.cell_value(r, c) != "" and sheet.cell_value(r, c) is not None
        }

        start_time_raw = row.get("运动时长")
        if not start_time_raw:
            continue

        try:
            st_ms = float(start_time_raw)
        except (ValueError, TypeError):
            continue

        end_time_raw = row.get("运动时长1", st_ms)
        try:
            et_ms = float(end_time_raw)
        except (ValueError, TypeError):
            et_ms = st_ms

        st_dt_utc = datetime.fromtimestamp(st_ms / 1000, tz=timezone.utc)
        et_dt_utc = datetime.fromtimestamp(et_ms / 1000, tz=timezone.utc)
        st_dt_local = datetime.fromtimestamp(st_ms / 1000)

        # 运动类型解析
        sport_type_code = int(float(row.get("运动类型", 2)))
        category, sport_name = SPORT_TYPE_MAP.get(sport_type_code, ("Workout", f"运动 (类型 {sport_type_code})"))

        # 指标解析
        dist_m = round(float(row.get("运动距离", 0)), 2)
        dur_ms = float(row.get("运动时长2", 0))
        dur_s = round(dur_ms / 1000) if dur_ms > 0 else round((et_ms - st_ms) / 1000)
        steps = int(float(row.get("步数", 0)))
        cal = int(float(row.get("消耗热量", 0)))
        
        # 配速与速度
        avg_pace_s = float(row.get("运动速率", 0))
        speed_kmh = round((dist_m / dur_s) * 3.6, 2) if dur_s > 0 else 0
        cadence = float(row.get("运动频率", 0))

        # 轨迹坐标与打卡点解析
        loc = None
        traj_str = row.get("行踪轨迹", "")
        if traj_str:
            try:
                t_obj = json.loads(str(traj_str).strip())
                if "latitude" in t_obj and "longitude" in t_obj:
                    loc = {
                        "latitude": float(t_obj["latitude"]),
                        "longitude": float(t_obj["longitude"]),
                        "altitude": float(t_obj.get("altitude", 0)) if t_obj.get("altitude") != 999999.0 else None,
                        "speed": float(t_obj.get("speed", 0))
                    }
            except Exception:
                pass

        # 构造独立运动 JSON
        date_str = st_dt_local.strftime("%Y%m%d_%H%M%S")
        record_id = f"vivo_{int(st_ms)}"
        activity_title = f"{st_dt_local.strftime('%Y-%m-%d %H:%M:%S')} {sport_name} ({(dist_m/1000):.2f}km)"

        activity_data = {
            "id": record_id,
            "source": "vivo_health",
            "name": activity_title,
            "sport_type": category.lower(),
            "sport_display": f"{sport_name} (vivo 运动健康)",
            "start_time": st_dt_utc.isoformat(),
            "end_time": et_dt_utc.isoformat(),
            "device": {
                "type": "phone",
                "name": "vivo",
                "model": "vivo Y76s"
            },
            "summary": {
                "duration_seconds": dur_s,
                "distance_meters": dist_m,
                "calories_kcal": cal,
                "steps": steps,
                "avg_speed_kmh": speed_kmh,
                "avg_pace_sec": round(avg_pace_s) if avg_pace_s > 0 else None,
                "avg_cadence": round(cadence) if cadence > 0 else None
            },
            "location": loc,
            "raw_record": row
        }

        # 输出目录
        cat_dir = output_root / category
        cat_dir.mkdir(parents=True, exist_ok=True)
        out_file = cat_dir / f"{date_str}_{category}.json"

        if out_file.exists() and not force:
            skipped_count += 1
        else:
            with open(out_file, "w", encoding="utf-8") as f:
                json.dump(activity_data, f, ensure_ascii=False, indent=2)
            extracted_count += 1

        records_summary.append({
            "id": record_id,
            "category": category,
            "name": activity_title,
            "date": st_dt_local.strftime("%Y-%m-%d %H:%M:%S"),
            "distance_km": round(dist_m / 1000, 2),
            "duration_min": round(dur_s / 60, 1),
            "calories_kcal": cal,
            "steps": steps,
            "location": loc,
            "file": str(out_file.relative_to(output_root))
        })

    return extracted_count, skipped_count, records_summary


def generate_summary_reports(output_root: Path, all_records: list[dict]):
    all_records.sort(key=lambda x: x["date"], reverse=True)

    # 1. activities_summary.json
    summary_json_file = output_root / "activities_summary.json"
    with open(summary_json_file, "w", encoding="utf-8") as f:
        json.dump({
            "source": "vivo_health",
            "extracted_at": datetime.now().isoformat(),
            "total_activities": len(all_records),
            "activities": all_records
        }, f, ensure_ascii=False, indent=2)

    # 2. summary.md 报表
    summary_md_file = output_root / "summary.md"
    
    total_dist = sum(r["distance_km"] for r in all_records)
    total_dur_min = sum(r["duration_min"] for r in all_records)
    total_cal = sum(r["calories_kcal"] for r in all_records)
    total_steps = sum(r["steps"] for r in all_records)

    categories = {}
    for r in all_records:
        cat = r["category"]
        if cat not in categories:
            categories[cat] = {"count": 0, "dist": 0.0, "dur": 0.0, "cal": 0, "steps": 0}
        categories[cat]["count"] += 1
        categories[cat]["dist"] += r["distance_km"]
        categories[cat]["dur"] += r["duration_min"]
        categories[cat]["cal"] += r["calories_kcal"]
        categories[cat]["steps"] += r["steps"]

    md_lines = [
        "# vivo 运动健康记录提取汇总报表",
        "",
        f"> 提取时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')} · 数据源: `VivoHealth/CSVs`",
        "",
        "## 📊 全量统计概览",
        "",
        "| 运动分类 | 场次 | 总距离 (km) | 总时长 | 总能量 (kcal) | 总步数 |",
        "| :--- | :---: | :---: | :---: | :---: | :---: |",
    ]

    for cat, stat in sorted(categories.items()):
        h = int(stat["dur"] // 60)
        m = int(stat["dur"] % 60)
        time_str = f"{h}小时{m}分" if h > 0 else f"{m}分"
        icon = "🏃" if cat == "Running" else "🚶" if cat == "Walking" else "🚴"
        md_lines.append(
            f"| {icon} **{cat}** | {stat['count']} | {stat['dist']:.2f} km | {time_str} | {stat['cal']} kcal | {stat['steps']:,} |"
        )

    h_total = int(total_dur_min // 60)
    m_total = int(total_dur_min % 60)
    md_lines.append(
        f"| 🏆 **总计 (Total)** | **{len(all_records)}** | **{total_dist:.2f} km** | **{h_total}小时{m_total}分** | **{total_cal:,} kcal** | **{total_steps:,}** |"
    )
    md_lines.extend([
        "",
        "---",
        "",
        "## 📋 提取记录列表",
        "",
        "| 日期与时间 | 运动类型 | 距离 (km) | 耗时 (分) | 步数 | 热量 (kcal) | 打卡起点坐标 |",
        "| :--- | :---: | :---: | :---: | :---: | :---: | :---: |",
    ])

    for r in all_records:
        loc_str = f"{r['location']['latitude']:.4f}°N, {r['location']['longitude']:.4f}°E" if r["location"] else "无定位"
        md_lines.append(
            f"| {r['date']} | `{r['category']}` | {r['distance_km']} km | {r['duration_min']} 分 | {r['steps']} | {r['calories_kcal']} | {loc_str} |"
        )

    with open(summary_md_file, "w", encoding="utf-8") as f:
        f.write("\n".join(md_lines) + "\n")


def main():
    args = parse_args()
    input_path = Path(args.input_path).resolve()
    output_root = Path(args.output_dir).resolve()

    if not input_path.exists():
        print(f"❌ 输入路径不存在: {input_path}")
        sys.exit(1)

    excel_files = find_excel_files(input_path)
    if not excel_files:
        print(f"❌ 在 {input_path} 下未找到 .xlsx 或 .xls 文件")
        sys.exit(1)

    print(f"🔍 发现 {len(excel_files)} 个 vivo 健康 Excel 文件:")
    for f in excel_files:
        print(f"   - {f.name} ({f.stat().st_size / 1024:.1f} KB)")

    output_root.mkdir(parents=True, exist_ok=True)

    all_extracted = 0
    all_skipped = 0
    all_records = []

    for f in excel_files:
        print(f"\n🚀 正在解析: {f.name}...")
        extracted, skipped, records = process_excel(f, output_root, args.force)
        all_extracted += extracted
        all_skipped += skipped
        all_records.extend(records)

    generate_summary_reports(output_root, all_records)

    print("\n" + "=" * 50)
    print("✅ vivo 运动健康记录提取完成！")
    print(f"   - 新增提取记录: {all_extracted} 份")
    if all_skipped > 0:
        print(f"   - 跳过已有记录: {all_skipped} 份 (使用 --force 可重新覆盖)")
    print(f"   - 总活动数: {len(all_records)} 场")
    print(f"   - 汇总数据表: {output_root / 'activities_summary.json'}")
    print(f"   - 可视化报表: {output_root / 'summary.md'}")
    print("=" * 50)


if __name__ == "__main__":
    main()
