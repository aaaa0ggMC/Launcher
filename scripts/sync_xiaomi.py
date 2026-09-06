#!/usr/bin/env python3
"""
sync_xiaomi.py — 小米运动健康 (Mi Fitness) 导出数据全量同步与分类工具

功能：
1. 扫描输入目录中的小米健康 CSV 导出文件 (*sport_track_data.csv, *sport_record.csv, *fitness_data.csv)。
2. 支持增量同步：自动检测目标目录已有文件，默认跳过以避免重复下载，仅在 --force 时强制重新下载与覆盖。
3. 多线程极速并发下载云端 GPX 轨迹。
4. 深度融合运动生理指标：
   - 将 *fitness_data.csv 中的高频心率按秒/分匹配注入每个 GPX 轨迹点的 Garmin <gpxtpx:hr> 扩展；
   - 在 GPX <trk> 中注入 YARJ 运动识别标准 (<type>, <name>, <desc>, <extensions>)。
5. 按运动类型自动分目录归类 (Cycling/, Running/, Walking/, Hiking/, Other/)。
6. 伴随生成全量指标 JSON 详情文件（含心率区间、步频步幅、配速、高度、训练负荷、VO2Max 等全部字段）。
7. 支持无 GPS 轨迹的室内运动记录归档。
8. 自动生成 activities_summary.json 与可视化 Markdown 统计报表 summary.md。
"""

import os
import sys
import csv
import json
import glob
import time
import bisect
import urllib.request
import argparse
import datetime
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed
import xml.etree.ElementTree as ET

# 运动类型映射字典
CATEGORY_MAP = {
    'outdoor_riding': {
        'dir': 'Cycling',
        'type': 'cycling',
        'zh': '户外骑行',
        'icon': '🚴'
    },
    'running': {
        'dir': 'Running',
        'type': 'running',
        'zh': '户外跑步',
        'icon': '🏃'
    },
    'outdoor_running': {
        'dir': 'Running',
        'type': 'running',
        'zh': '户外跑步',
        'icon': '🏃'
    },
    'walking': {
        'dir': 'Walking',
        'type': 'walking',
        'zh': '户外健走',
        'icon': '🚶'
    },
    'outdoor_walking': {
        'dir': 'Walking',
        'type': 'walking',
        'zh': '户外健走',
        'icon': '🚶'
    },
    'outdoor_hiking': {
        'dir': 'Hiking',
        'type': 'hiking',
        'zh': '户外徒步',
        'icon': '🥾'
    },
}

DEFAULT_CATEGORY = {
    'dir': 'Other',
    'type': 'other',
    'zh': '其他运动',
    'icon': '🏅'
}

def parse_duration(sec: int) -> str:
    """将秒数转为友好的时分秒字符串"""
    if sec < 60:
        return f"{sec}秒"
    m, s = divmod(sec, 60)
    h, m = divmod(m, 60)
    if h > 0:
        return f"{h}小时{m:02d}分{s:02d}秒" if s > 0 else f"{h}小时{m:02d}分"
    return f"{m}分{s:02d}秒" if s > 0 else f"{m}分钟"

def find_csv_files(csv_dir: Path):
    """在目录下自动查找对应的 CSV 文件"""
    track_file = None
    record_file = None
    fitness_file = None

    for f in csv_dir.glob("*.csv"):
        name = f.name.lower()
        if "sport_track_data" in name:
            track_file = f
        elif "sport_record" in name:
            record_file = f
        elif "fitness_data" in name and "aggregated" not in name and "user_fitness" not in name:
            fitness_file = f

    return track_file, record_file, fitness_file

def load_heart_rates(fitness_file: Path):
    """从 fitness_data.csv 中加载连续心率时序数据，返回排好序的时间戳与对应心率列表"""
    if not fitness_file or not fitness_file.exists():
        return [], []

    print(f"[*] 正在从 {fitness_file.name} 加载高频心率监测数据...")
    t0 = time.time()
    hr_times = []
    hr_bpms = []

    try:
        with open(fitness_file, "r", encoding="utf-8", errors="replace") as f:
            reader = csv.DictReader(f)
            for row in reader:
                if row.get("Key") == "heart_rate":
                    try:
                        t = int(row["Time"])
                        val = json.loads(row["Value"])
                        bpm = int(val.get("bpm", 0))
                        if bpm > 0:
                            hr_times.append(t)
                            hr_bpms.append(bpm)
                    except Exception:
                        continue

        # 如果时间戳是逆序排列的，做一次翻转保证升序
        if hr_times and hr_times[0] > hr_times[-1]:
            hr_times.reverse()
            hr_bpms.reverse()

        print(f"[+] 成功索引 {len(hr_times):,} 条心率采样点 (耗时 {time.time() - t0:.2f}s)")
        return hr_times, hr_bpms
    except Exception as e:
        print(f"[-] 加载心率数据失败: {e}")
        return [], []

def find_closest_hr(query_time: int, hr_times, hr_bpms, tolerance_sec=60):
    """使用二分搜索查找与指定时间戳最近的心率值"""
    if not hr_times:
        return None
    idx = bisect.bisect_left(hr_times, query_time)
    best_diff = float("inf")
    best_bpm = None

    for candidate_idx in (idx - 1, idx, idx + 1):
        if 0 <= candidate_idx < len(hr_times):
            diff = abs(hr_times[candidate_idx] - query_time)
            if diff <= tolerance_sec and diff < best_diff:
                best_diff = diff
                best_bpm = hr_bpms[candidate_idx]

    return best_bpm

def download_gpx(url: str, max_retries=3) -> bytes:
    """带重试机制的 GPX 文件下载"""
    headers = {
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
    }
    req = urllib.request.Request(url, headers=headers)
    for attempt in range(max_retries):
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                data = resp.read()
                if len(data) > 0 and b"<gpx" in data:
                    return data
                raise ValueError("下载内容不是有效的 GPX 数据")
        except Exception as e:
            if attempt == max_retries - 1:
                raise e
            time.sleep(1.0 * (attempt + 1))
    raise RuntimeError("下载重试次数超限")

def enrich_gpx(
    raw_xml_bytes: bytes,
    activity_name: str,
    desc: str,
    sport_type: str,
    metrics: dict,
    hr_times,
    hr_bpms,
    tolerance_sec=60
) -> tuple[bytes, dict]:
    """
    解析原始 GPX，注入标准 GPX 1.1 属性、YARJ 识别标签、统计扩展及 TrackPoint 心率扩展。
    返回 (处理后的 xml 字节串, 航线点统计字典)。
    """
    root = ET.fromstring(raw_xml_bytes)

    # 规范化 root 属性与 Garmin 扩展命名空间
    root.attrib["version"] = "1.1"
    root.attrib["creator"] = "MiFitness Sync"
    root.attrib["xmlns"] = "http://www.topografix.com/GPX/1/1"
    root.attrib["xmlns:gpxtpx"] = "http://www.garmin.com/xmlschemas/TrackPointExtension/v1"
    root.attrib["xmlns:xsi"] = "http://www.w3.org/2001/XMLSchema-instance"
    root.attrib["xsi:schemaLocation"] = (
        "http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd "
        "http://www.garmin.com/xmlschemas/TrackPointExtension/v1 http://www.garmin.com/xmlschemas/TrackPointExtensionv1.xsd"
    )

    # 定位或创建 trk
    trk = root.find(".//{*}trk")
    if trk is None:
        trk = root.find(".//trk")
    if trk is None:
        trk = ET.SubElement(root, "trk")

    # 更新 name
    name_elem = trk.find("{*}name")
    if name_elem is None:
        name_elem = trk.find("name")
    if name_elem is None:
        name_elem = ET.Element("name")
        trk.insert(0, name_elem)
    name_elem.text = activity_name

    # 插入 desc
    desc_elem = trk.find("{*}desc")
    if desc_elem is None:
        desc_elem = trk.find("desc")
    if desc_elem is None:
        desc_elem = ET.Element("desc")
        trk.insert(1, desc_elem)
    desc_elem.text = desc

    # 插入 type (用于 YARJ 及主流运动软件直接识别运动类型)
    type_elem = trk.find("{*}type")
    if type_elem is None:
        type_elem = trk.find("type")
    if type_elem is None:
        type_elem = ET.Element("type")
        trk.insert(2, type_elem)
    type_elem.text = sport_type

    # 插入 extensions
    ext_elem = trk.find("{*}extensions")
    if ext_elem is None:
        ext_elem = trk.find("extensions")
    if ext_elem is None:
        ext_elem = ET.Element("extensions")
        trk.insert(3, ext_elem)

    # 写入指标到 extensions (保留并覆写)
    for k, v in metrics.items():
        if v is not None and v != "":
            sub = ext_elem.find(f"{{*}}{k}")
            if sub is None:
                sub = ext_elem.find(k)
            if sub is None:
                sub = ET.SubElement(ext_elem, k)
            sub.text = str(v)

    # 遍历处理所有的 trkpt，注入心率并收集包围盒
    min_lat, min_lon = 90.0, 180.0
    max_lat, max_lon = -90.0, -180.0
    points_count = 0
    hr_matched_count = 0

    for trkpt in root.iter():
        tag = trkpt.tag.split("}")[-1]
        if tag == "trkpt":
            points_count += 1
            lat = float(trkpt.attrib.get("lat", 0))
            lon = float(trkpt.attrib.get("lon", 0))
            min_lat = min(min_lat, lat)
            max_lat = max(max_lat, lat)
            min_lon = min(min_lon, lon)
            max_lon = max(max_lon, lon)

            # 提取时间戳匹配心率
            time_elem = trkpt.find("{*}time")
            if time_elem is None:
                time_elem = trkpt.find("time")

            if time_elem is not None and time_elem.text and hr_times:
                t_str = time_elem.text.strip()
                try:
                    # 解析 2026-09-05T10:01:21Z 格式
                    if t_str.endswith("Z"):
                        t_iso = t_str[:-1] + "+00:00"
                    else:
                        t_iso = t_str
                    pt_dt = datetime.datetime.fromisoformat(t_iso)
                    pt_ts = int(pt_dt.timestamp())

                    bpm = find_closest_hr(pt_ts, hr_times, hr_bpms, tolerance_sec)
                    if bpm:
                        hr_matched_count += 1
                        pt_ext = trkpt.find("{*}extensions")
                        if pt_ext is None:
                            pt_ext = trkpt.find("extensions")
                        if pt_ext is None:
                            pt_ext = ET.SubElement(trkpt, "extensions")

                        tpx = ET.SubElement(pt_ext, "gpxtpx:TrackPointExtension")
                        hr_el = ET.SubElement(tpx, "gpxtpx:hr")
                        hr_el.text = str(bpm)
                except Exception:
                    pass

    stats = {
        "points_count": points_count,
        "hr_matched_count": hr_matched_count,
        "bounds": [min_lon, min_lat, max_lon, max_lat] if points_count > 0 else None
    }

    # 导出规范 XML
    out_xml = ET.tostring(root, encoding="utf-8", xml_declaration=True)
    return out_xml, stats

def main():
    parser = argparse.ArgumentParser(
        description="小米运动健康 (Mi Fitness) 导出数据同步与自动分类工具"
    )
    parser.add_argument("csv_dir", type=str, help="包含小米健康导出 CSV 的目录路径")
    parser.add_argument("output_dir", type=str, help="同步输出的目标目录路径")
    parser.add_argument(
        "--force", "-f", action="store_true", help="强制重新下载并覆盖目标目录中已存在的文件"
    )
    parser.add_argument(
        "--workers", "-w", type=int, default=8, help="并发下载线程数 (默认: 8)"
    )
    parser.add_argument(
        "--no-hr", action="store_true", help="跳过从 fitness_data.csv 中加载高频心率数据"
    )
    parser.add_argument(
        "--keep-raw-gpx", action="store_true", help="额外保留从云端拉取的原始未增强 GPX 文件 (*.raw.gpx)"
    )
    parser.add_argument(
        "--hr-tolerance", type=int, default=60, help="心率匹配最大时间容差（秒，默认 60s）"
    )

    args = parser.parse_args()

    csv_dir = Path(args.csv_dir).expanduser().resolve()
    output_dir = Path(args.output_dir).expanduser().resolve()

    if not csv_dir.exists() or not csv_dir.is_dir():
        print(f"错误: 输入目录不存在: {csv_dir}", file=sys.stderr)
        sys.exit(1)

    output_dir.mkdir(parents=True, exist_ok=True)

    print("=" * 68)
    print(" 🚀 小米运动健康 (Mi Fitness) 轨迹同步与智能归类引擎")
    print("=" * 68)
    print(f"  📂 输入目录 : {csv_dir}")
    print(f"  🎯 输出目录 : {output_dir}")
    print(f"  🔄 覆盖模式 : {'--force 开启 (全部重下覆盖)' if args.force else '增量检查 (跳过已有文件)'}")
    print(f"  ⚡ 并发线程 : {args.workers}")
    print("-" * 68)

    # 1. 扫描与定位 CSV 文件
    track_file, record_file, fitness_file = find_csv_files(csv_dir)

    if not track_file or not track_file.exists():
        print(f"错误: 在 {csv_dir} 中未找到轨迹数据文件 (*sport_track_data.csv)！", file=sys.stderr)
        sys.exit(1)

    print(f"[+] 找到轨迹索引文件 : {track_file.name}")
    if record_file:
        print(f"[+] 找到运动记录文件 : {record_file.name}")
    else:
        print("[-] 未找到 sport_record.csv，将使用默认运动分类", file=sys.stderr)

    # 2. 加载高频心率数据 (如果开启)
    hr_times, hr_bpms = [], []
    if not args.no_hr and fitness_file:
        hr_times, hr_bpms = load_heart_rates(fitness_file)
    elif args.no_hr:
        print("[*] 用户指定 --no-hr，跳过心率加载")

    # 3. 解析运动记录 (sport_record.csv) 建立索引
    records_by_time = {}
    all_records = []
    if record_file and record_file.exists():
        with open(record_file, "r", encoding="utf-8", errors="replace") as f:
            for row in csv.DictReader(f):
                try:
                    t = int(row["Time"])
                    records_by_time[t] = row
                    all_records.append(row)
                except Exception:
                    pass
        print(f"[+] 成功读取 {len(records_by_time)} 条结构化运动记录")

    # 4. 解析轨迹列表 (sport_track_data.csv)
    raw_tracks = []
    with open(track_file, "r", encoding="utf-8", errors="replace") as f:
        for row in csv.DictReader(f):
            if row.get("GPX") and row["GPX"].startswith("http"):
                raw_tracks.append(row)

    print(f"[+] 成功读取 {len(raw_tracks)} 条云端轨迹记录")

    # 5. 匹配轨迹与运动记录，规划文件命名与分类目录
    planned_tasks = []
    matched_record_times = set()

    # 检测设备冲突（同一时间戳或相差 <= 5s 的记录加设备后缀）
    timestamps = [int(t["Time"]) for t in raw_tracks]
    has_time_collision = set()
    for i in range(len(timestamps)):
        for j in range(i + 1, len(timestamps)):
            if abs(timestamps[i] - timestamps[j]) <= 5:
                has_time_collision.add(timestamps[i])
                has_time_collision.add(timestamps[j])

    for track in raw_tracks:
        track_time = int(track["Time"])
        did = track.get("Did", "")
        gpx_url = track["GPX"]

        # 匹配对应 record（先精确匹配，再容差 +/- 5s）
        rec = records_by_time.get(track_time)
        rec_time = track_time
        if not rec:
            for offset in (1, -1, 2, -2, 3, -3, 4, -4, 5, -5):
                if track_time + offset in records_by_time:
                    rec = records_by_time[track_time + offset]
                    rec_time = track_time + offset
                    break

        if rec:
            matched_record_times.add(rec_time)
            cat_key = rec.get("Category", "").lower()
            try:
                rec_val = json.loads(rec.get("Value", "{}"))
            except Exception:
                rec_val = {}
        else:
            cat_key = track.get("Key", "").lower()
            rec_val = {}

        cat_cfg = CATEGORY_MAP.get(cat_key, DEFAULT_CATEGORY)
        cat_dir_name = cat_cfg["dir"]
        sport_type = cat_cfg["type"]
        sport_zh = cat_cfg["zh"]

        # 生成规范命名: YYYYMMDD_HHMMSS_<Category>[_<device>]
        dt = datetime.datetime.fromtimestamp(track_time)
        date_str = dt.strftime("%Y%m%d_%H%M%S")
        date_readable = dt.strftime("%Y-%m-%d %H:%M:%S")

        device_suffix = ""
        if track_time in has_time_collision:
            if did == "xiaomiwear_app":
                device_suffix = "_phone"
            elif did:
                device_suffix = "_watch"

        base_name = f"{date_str}_{cat_dir_name}{device_suffix}"
        target_dir = output_dir / cat_dir_name
        target_gpx = target_dir / f"{base_name}.gpx"
        target_json = target_dir / f"{base_name}.json"
        target_raw_gpx = target_dir / f"{base_name}.raw.gpx"

        planned_tasks.append({
            "track_time": track_time,
            "dt": dt,
            "date_readable": date_readable,
            "base_name": base_name,
            "cat_cfg": cat_cfg,
            "sport_type": sport_type,
            "sport_zh": sport_zh,
            "target_dir": target_dir,
            "target_gpx": target_gpx,
            "target_json": target_json,
            "target_raw_gpx": target_raw_gpx,
            "gpx_url": gpx_url,
            "did": did,
            "rec_val": rec_val,
            "rec_raw": rec
        })

    # 6. 增量校验并筛选待下载项
    to_download = []
    skipped_count = 0

    for task in planned_tasks:
        if (
            not args.force
            and task["target_gpx"].exists()
            and task["target_gpx"].stat().st_size > 0
            and task["target_json"].exists()
            and task["target_json"].stat().st_size > 0
        ):
            skipped_count += 1
            task["status"] = "skipped"
        else:
            task["status"] = "pending"
            to_download.append(task)

    print(f"[+] 规划完成: 总计 {len(planned_tasks)} 条轨迹")
    if skipped_count > 0:
        print(f"[*] 增量检测: 发现 {skipped_count} 条轨迹已存在且完整，自动跳过 (使用 --force 可重新覆盖)")
    print(f"[*] 本次需执行下载与处理: {len(to_download)} 条")

    # 7. 并发执行下载与处理任务
    success_count = 0
    failed_tasks = []

    def process_task(task):
        task["target_dir"].mkdir(parents=True, exist_ok=True)
        # 1. 下载 GPX 原始内容
        raw_bytes = download_gpx(task["gpx_url"])
        if args.keep_raw_gpx:
            task["target_raw_gpx"].write_bytes(raw_bytes)

        # 2. 准备指标与描述
        rec_val = task["rec_val"]
        dist_m = rec_val.get("distance", 0)
        dur_s = rec_val.get("duration", 0)
        cal = rec_val.get("calories", rec_val.get("total_cal", 0))
        avg_speed = rec_val.get("avg_speed", 0)
        max_speed = rec_val.get("max_speed", 0)
        avg_hrm = rec_val.get("avg_hrm", 0)
        max_hrm = rec_val.get("max_hrm", 0)
        rise_height = rec_val.get("rise_height", 0)
        fall_height = rec_val.get("fall_height", 0)
        steps = rec_val.get("steps", 0)
        avg_cadence = rec_val.get("avg_cadence", 0)
        max_cadence = rec_val.get("max_cadence", 0)

        # 构造人类可读 desc
        desc_parts = []
        if dist_m > 0:
            desc_parts.append(f"距离: {dist_m / 1000:.2f}km")
        if dur_s > 0:
            desc_parts.append(f"耗时: {parse_duration(dur_s)}")
        if avg_speed > 0:
            desc_parts.append(f"均速: {avg_speed:.1f}km/h")
        if max_speed > 0:
            desc_parts.append(f"极速: {max_speed:.1f}km/h")
        if cal > 0:
            desc_parts.append(f"消耗: {cal}kcal")
        if avg_hrm > 0:
            desc_parts.append(f"均心率: {avg_hrm}bpm")
        if rise_height > 0:
            desc_parts.append(f"累计爬升: {rise_height}m")

        desc_str = " | ".join(desc_parts) if desc_parts else "小米健康运动导出"
        act_name = f"{task['date_readable']} {task['sport_zh']}"
        if dist_m > 0:
            act_name += f" ({dist_m / 1000:.2f}km)"

        # 构造注入 extensions 的结构化 metrics
        gpx_metrics = {
            "totalDistance": dist_m,
            "duration": dur_s,
            "calories": cal,
            "avgSpeed": avg_speed,
            "maxSpeed": max_speed,
            "avgHrm": avg_hrm,
            "maxHrm": max_hrm,
            "riseHeight": rise_height,
            "fallHeight": fall_height,
            "steps": steps,
            "avgCadence": avg_cadence,
            "maxCadence": max_cadence
        }

        # 3. 增强 GPX 注入心率与标签
        enriched_xml, track_stats = enrich_gpx(
            raw_bytes,
            act_name,
            desc_str,
            task["sport_type"],
            gpx_metrics,
            hr_times,
            hr_bpms,
            tolerance_sec=args.hr_tolerance
        )

        task["target_gpx"].write_bytes(enriched_xml)

        # 4. 生成高精度全量 JSON 详情文件
        json_payload = {
            "id": task["base_name"],
            "name": act_name,
            "category": task["cat_cfg"]["dir"],
            "sport_type": task["sport_type"],
            "sport_display": task["sport_zh"],
            "timestamp": task["track_time"],
            "start_time": task["date_readable"],
            "device": {
                "did": task["did"],
                "type": "watch" if task["did"] != "xiaomiwear_app" and task["did"] else "app"
            },
            "summary": {
                "distance_meters": dist_m,
                "distance_km": round(dist_m / 1000, 2),
                "duration_seconds": dur_s,
                "duration_formatted": parse_duration(dur_s),
                "calories_kcal": cal,
                "avg_speed_kmh": avg_speed,
                "max_speed_kmh": max_speed,
                "avg_pace_sec": rec_val.get("avg_pace"),
                "max_pace_sec": rec_val.get("max_pace"),
                "min_pace_sec": rec_val.get("min_pace"),
                "steps": steps,
                "avg_cadence": avg_cadence,
                "max_cadence": max_cadence,
                "avg_stride_cm": rec_val.get("avg_stride"),
                "avg_hrm": avg_hrm,
                "max_hrm": max_hrm,
                "min_hrm": rec_val.get("min_hrm"),
                "rise_height_m": rise_height,
                "fall_height_m": fall_height,
                "vo2_max": rec_val.get("vo2_max"),
                "train_load": rec_val.get("train_load"),
                "train_effect": rec_val.get("train_effect"),
                "recover_time_hours": rec_val.get("recover_time")
            },
            "heart_rate_zones": {
                "warm_up_duration_sec": rec_val.get("hrm_warm_up_duration"),
                "fat_burning_duration_sec": rec_val.get("hrm_fat_burning_duration"),
                "aerobic_duration_sec": rec_val.get("hrm_aerobic_duration"),
                "anaerobic_duration_sec": rec_val.get("hrm_anaerobic_duration"),
                "extreme_duration_sec": rec_val.get("hrm_extreme_duration")
            },
            "track_stats": track_stats,
            "raw_record": rec_val
        }

        with open(task["target_json"], "w", encoding="utf-8") as jf:
            json.dump(json_payload, jf, ensure_ascii=False, indent=2)

        task["result_summary"] = json_payload["summary"]
        task["track_stats"] = track_stats
        return task

    if to_download:
        print(f"[*] 开始多线程并发下载与增强 (并发数={args.workers})...")
        t_start = time.time()
        with ThreadPoolExecutor(max_workers=args.workers) as executor:
            future_to_task = {executor.submit(process_task, t): t for t in to_download}
            for future in as_completed(future_to_task):
                task = future_to_task[future]
                try:
                    res = future.result()
                    success_count += 1
                    dist_km = res["result_summary"]["distance_km"]
                    hr_info = f", 心率注入={res['track_stats']['hr_matched_count']}点" if res['track_stats']['hr_matched_count'] > 0 else ""
                    print(
                        f"  [{success_count + skipped_count}/{len(planned_tasks)}] {task['cat_cfg']['icon']} 已同步: "
                        f"{task['target_gpx'].name} ({dist_km}km, {res['track_stats']['points_count']}点{hr_info})"
                    )
                except Exception as e:
                    failed_tasks.append((task["base_name"], str(e)))
                    print(f"  ❌ 同步失败: {task['base_name']}: {e}", file=sys.stderr)

        print(f"[+] 下载与处理完成，用时 {time.time() - t_start:.2f}s (成功: {success_count}, 失败: {len(failed_tasks)})")

    # 8. 处理未包含 GPS 轨迹的室内运动记录 (如跑步机室内跑步)
    non_gps_records = []
    for rec in all_records:
        rt = int(rec["Time"])
        if rt not in matched_record_times:
            non_gps_records.append(rec)

    if non_gps_records:
        print(f"[*] 发现 {len(non_gps_records)} 条无 GPS 轨迹的运动记录，生成离线详情...")
        for rec in non_gps_records:
            try:
                rt = int(rec["Time"])
                dt = datetime.datetime.fromtimestamp(rt)
                cat_key = rec.get("Category", "").lower()
                cat_cfg = CATEGORY_MAP.get(cat_key, DEFAULT_CATEGORY)
                cat_dir = output_dir / cat_cfg["dir"]
                cat_dir.mkdir(parents=True, exist_ok=True)

                base_name = f"{dt.strftime('%Y%m%d_%H%M%S')}_{cat_cfg['dir']}_indoor"
                json_path = cat_dir / f"{base_name}.json"

                if not args.force and json_path.exists():
                    continue

                rec_val = json.loads(rec.get("Value", "{}"))
                dist_m = rec_val.get("distance", 0)
                dur_s = rec_val.get("duration", 0)

                payload = {
                    "id": base_name,
                    "name": f"{dt.strftime('%Y-%m-%d %H:%M:%S')} {cat_cfg['zh']} (室内/无轨迹)",
                    "category": cat_cfg["dir"],
                    "sport_type": cat_cfg["type"],
                    "sport_display": f"{cat_cfg['zh']}(室内)",
                    "timestamp": rt,
                    "start_time": dt.strftime("%Y-%m-%d %H:%M:%S"),
                    "device": {"did": rec.get("Sid", ""), "type": "indoor"},
                    "summary": {
                        "distance_meters": dist_m,
                        "distance_km": round(dist_m / 1000, 2),
                        "duration_seconds": dur_s,
                        "duration_formatted": parse_duration(dur_s),
                        "calories_kcal": rec_val.get("calories", 0),
                        "avg_speed_kmh": rec_val.get("avg_speed", 0),
                        "max_speed_kmh": rec_val.get("max_speed", 0),
                        "steps": rec_val.get("steps", 0),
                        "avg_cadence": rec_val.get("avg_cadence", 0),
                        "avg_hrm": rec_val.get("avg_hrm", 0),
                        "max_hrm": rec_val.get("max_hrm", 0)
                    },
                    "raw_record": rec_val
                }

                with open(json_path, "w", encoding="utf-8") as jf:
                    json.dump(payload, jf, ensure_ascii=False, indent=2)
                print(f"  [+] 已归档室内记录: {json_path.name}")
            except Exception as e:
                print(f"  [-] 归档室内记录失败: {e}")

    # 9. 聚合全量活动数据，生成 activities_summary.json 与 summary.md
    print("[*] 正在汇总统计算法与生成总览报表...")
    all_summaries = []
    category_totals = {}

    for json_file in sorted(output_dir.glob("*/*.json")):
        try:
            with open(json_file, "r", encoding="utf-8") as f:
                data = json.load(f)
                cat = data.get("category", "Other")
                summ = data.get("summary", {})
                dist_km = summ.get("distance_km", 0.0)
                dur_s = summ.get("duration_seconds", 0)
                cal = summ.get("calories_kcal", 0)

                if cat not in category_totals:
                    category_totals[cat] = {
                        "count": 0,
                        "distance_km": 0.0,
                        "duration_sec": 0,
                        "calories": 0
                    }
                category_totals[cat]["count"] += 1
                category_totals[cat]["distance_km"] += dist_km
                category_totals[cat]["duration_sec"] += dur_s
                category_totals[cat]["calories"] += cal

                all_summaries.append({
                    "id": data.get("id"),
                    "name": data.get("name"),
                    "category": cat,
                    "sport_display": data.get("sport_display"),
                    "start_time": data.get("start_time"),
                    "distance_km": dist_km,
                    "duration_seconds": dur_s,
                    "duration_formatted": summ.get("duration_formatted"),
                    "calories_kcal": cal,
                    "avg_speed_kmh": summ.get("avg_speed_kmh"),
                    "avg_hrm": summ.get("avg_hrm"),
                    "gpx_file": str((json_file.with_suffix(".gpx")).relative_to(output_dir)) if json_file.with_suffix(".gpx").exists() else None,
                    "json_file": str(json_file.relative_to(output_dir))
                })
        except Exception:
            pass

    # 写入 activities_summary.json
    all_summaries.sort(key=lambda x: x["start_time"], reverse=True)
    summary_json_path = output_dir / "activities_summary.json"
    with open(summary_json_path, "w", encoding="utf-8") as f:
        json.dump({
            "generated_at": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "total_activities": len(all_summaries),
            "category_totals": category_totals,
            "activities": all_summaries
        }, f, ensure_ascii=False, indent=2)

    # 写入 summary.md
    md_lines = [
        "# 小米运动健康 (Mi Fitness) 全量运动轨迹与数据汇总\n",
        f"> 统计生成时间：`{datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')}` | 记录总数：**{len(all_summaries)}** 场\n",
        "## 📊 运动分类汇总\n",
        "| 运动分类 | 场次 | 总距离 (km) | 总时长 | 总能量消耗 (kcal) |",
        "| :--- | :---: | :---: | :---: | :---: |"
    ]

    total_dist = sum(c["distance_km"] for c in category_totals.values())
    total_sec = sum(c["duration_sec"] for c in category_totals.values())
    total_cal = sum(c["calories"] for c in category_totals.values())

    for cat, tot in sorted(category_totals.items()):
        cfg = next((c for c in CATEGORY_MAP.values() if c["dir"] == cat), DEFAULT_CATEGORY)
        md_lines.append(
            f"| {cfg['icon']} **{cfg['zh']}** (`{cat}`) | {tot['count']} | "
            f"{tot['distance_km']:.2f} km | {parse_duration(tot['duration_sec'])} | {tot['calories']:,} kcal |"
        )

    md_lines.append(
        f"| 🏆 **总计 (Total)** | **{len(all_summaries)}** | "
        f"**{total_dist:.2f} km** | **{parse_duration(total_sec)}** | **{total_cal:,} kcal** |\n"
    )

    md_lines.extend([
        "## 📑 运动轨迹清单\n",
        "| 开始时间 | 运动类型 | 距离 | 耗时 | 均速 | 均心率 | GPX 文件 | 详情 JSON |",
        "| :--- | :--- | :---: | :---: | :---: | :---: | :--- | :--- |"
    ])

    for act in all_summaries:
        gpx_link = f"[`GPX`]({act['gpx_file']})" if act['gpx_file'] else "*(无)*"
        json_link = f"[`JSON`]({act['json_file']})"
        spd_str = f"{act['avg_speed_kmh']:.1f} km/h" if act['avg_speed_kmh'] else "-"
        hr_str = f"{act['avg_hrm']} bpm" if act['avg_hrm'] else "-"
        md_lines.append(
            f"| {act['start_time']} | {act['sport_display']} | {act['distance_km']:.2f} km | "
            f"{act['duration_formatted']} | {spd_str} | {hr_str} | {gpx_link} | {json_link} |"
        )

    summary_md_path = output_dir / "summary.md"
    summary_md_path.write_text("\n".join(md_lines), encoding="utf-8")

    print("=" * 68)
    print(" 🎉 全量同步与分类已圆满完成！")
    print(f"  📁 输出目录: {output_dir}")
    print(f"  📈 汇总 JSON: {summary_json_path.name}")
    print(f"  📝 汇总报表: {summary_md_path.name}")
    print("=" * 68)

if __name__ == "__main__":
    main()
