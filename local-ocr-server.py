# -*- coding: utf-8 -*-
"""
本地 OCR 服务 v5（PaddleOCR 加速版 + 局域网 + 服务端切图·无重叠）—— 漫画翻译引擎的本地识别后端。

相对 v4 的改动：
- 切图不再重叠（STRIP_OVERLAP=0），与电脑端分块行为一致，避免重叠区多检出重复/误检文字，
  解决手机端 OCR 段数不稳定（31 vs 28）导致翻译卡住、token 翻倍的问题。
- 增加超长误检过滤：单条文字超过 200 字直接丢弃，防止大块误检塞进翻译消耗 token。

其余同 v4：MKLDNN 加速 + 关角度分类 + 0.0.0.0 监听（局域网可访问）。

启动：
    python local-ocr-server-v5.py
访问：
    本机 http://127.0.0.1:8000/ocr ；局域网 http://本机IP:8000/ocr
"""
import os
os.environ['FLAGS_use_mkldnn'] = '1'

import base64
import numpy as np
import cv2
from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI()

HOST = '0.0.0.0'
PORT = 8000

LANG_MAP = {'KOR': 'korean', 'JAP': 'japan', 'ENG': 'en', 'CHN': 'ch'}
USE_ANGLE_CLS = False

# 服务端切块：高度超过这个值就切成多条分别识别（避免 PaddleOCR 内部放大导致慢/内存高）
STRIP_H = 3000
STRIP_OVERLAP = 0     # 不重叠：与电脑端分块一致，避免重叠区多检出重复文字

_engines = {}


class OcrRequest(BaseModel):
    image: str                    # 纯 base64（不带 data:image/...;base64, 前缀）
    language_type: str = 'KOR'    # KOR / JAP / ENG / CHN


def get_engine(plang):
    if plang not in _engines:
        from paddleocr import PaddleOCR
        try:
            engine = PaddleOCR(use_angle_cls=USE_ANGLE_CLS, lang=plang, show_log=False, enable_mkldnn=True)
        except TypeError:
            try:
                engine = PaddleOCR(use_angle_cls=USE_ANGLE_CLS, lang=plang, show_log=False)
            except TypeError:
                engine = PaddleOCR(use_angle_cls=USE_ANGLE_CLS, lang=plang)
        if not hasattr(engine, 'ocr'):
            raise RuntimeError('检测到 PaddleOCR 3.x，请装 2.x：pip install "paddleocr==2.7.3"')
        _engines[plang] = engine
    return _engines[plang]


def ocr_strip(engine, strip_img):
    """识别单条图片，返回 [{words, location}, ...]，坐标相对该条左上角。"""
    result = engine.ocr(strip_img, cls=USE_ANGLE_CLS)
    lines = result[0] if result else []
    out = []
    for line in lines or []:
        if line is None:
            continue
        box = line[0]
        text, _score = line[1]
        if not text or not text.strip():
            continue
        if len(text.strip()) > 200:
            continue
        xs = [p[0] for p in box]
        ys = [p[1] for p in box]
        left = int(min(xs))
        top = int(min(ys))
        width = int(max(xs) - left)
        height = int(max(ys) - top)
        out.append({
            'words': text.strip(),
            'location': {'left': left, 'top': top, 'width': width, 'height': height},
        })
    return out


def box_iou(a, b):
    ax1, ay1 = a['left'], a['top']
    ax2, ay2 = a['left'] + a['width'], a['top'] + a['height']
    bx1, by1 = b['left'], b['top']
    bx2, by2 = b['left'] + b['width'], b['top'] + b['height']
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    iw, ih = max(0, ix2 - ix1), max(0, iy2 - iy1)
    inter = iw * ih
    if inter <= 0:
        return 0.0
    area_a = (ax2 - ax1) * (ay2 - ay1)
    area_b = (bx2 - bx1) * (by2 - by1)
    union = area_a + area_b - inter
    return inter / union if union > 0 else 0.0


def dedup_lines(lines):
    """去掉切块重叠产生的重复行：保留面积大的（完整的那条），丢弃与其重叠的小块。"""
    lines = sorted(lines, key=lambda ln: ln['location']['width'] * ln['location']['height'], reverse=True)
    keep = []
    for ln in lines:
        dup = False
        for k in keep:
            if box_iou(ln['location'], k['location']) > 0.3:
                dup = True
                break
        if not dup:
            keep.append(ln)
    return keep


@app.post('/ocr')
def ocr(req: OcrRequest):
    try:
        raw = base64.b64decode(req.image)
    except Exception:
        return {'error_code': -1, 'error_msg': 'invalid base64'}
    nparr = np.frombuffer(raw, np.uint8)
    img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    if img is None:
        return {'error_code': -1, 'error_msg': 'decode image failed'}
    plang = LANG_MAP.get(req.language_type, 'korean')
    try:
        engine = get_engine(plang)
        H = img.shape[0]
        all_lines = []
        if H <= STRIP_H:
            all_lines = ocr_strip(engine, img)
        else:
            y0 = 0
            while y0 < H:
                y1 = min(y0 + STRIP_H + STRIP_OVERLAP, H)
                strip = img[y0:y1, :]
                lines = ocr_strip(engine, strip)
                for ln in lines:
                    ln['location']['top'] += y0
                    all_lines.append(ln)
                if y1 >= H:
                    break
                y0 += STRIP_H
        words_result = dedup_lines(all_lines)
    except Exception as e:
        return {'error_code': -1, 'error_msg': str(e)}
    return {'words_result': words_result, 'words_result_num': len(words_result)}


@app.get('/')
def root():
    return {'ok': True, 'message': 'local PaddleOCR server v4 running. POST /ocr'}


if __name__ == '__main__':
    import uvicorn
    uvicorn.run(app, host=HOST, port=PORT)
