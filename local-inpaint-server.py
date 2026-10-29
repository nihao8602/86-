# -*- coding: utf-8 -*-
"""
本地漫画擦除服务（LaMa / ONNX）—— 漫画翻译引擎的「模型擦除」后端。

**独立进程、独立端口，不碰你 8000 上的 OCR 服务。**

    8000  → 你现有的 OCR 服务（PaddleOCR / 百度代理等），本文件不涉及
    8001  → 本服务，只做 /inpaint

做什么：
    收到「一块裁剪图 + 一块 mask（白=要擦掉的地方）」，用 LaMa 把白区补成周围背景，
    返回补好的 PNG。插件把它当气泡底，替代「白色膨胀」的像素滤波。

第一次用前（各一次）：
    pip install onnxruntime
    python local-inpaint-server.py --download-model     # 约 198MB → models/lama_fp32.onnx

启动：
    python local-inpaint-server.py                # 默认 127.0.0.1:8001
    python local-inpaint-server.py --port 8010    # 换端口
    python local-inpaint-server.py --host 0.0.0.0 --port 8001   # 让局域网（手机）也能用

环境变量：
    LAMA_MODEL       模型路径（默认 models/lama_fp32.onnx）
    LAMA_MODEL_URL   下载地址（默认 HuggingFace，国内可换镜像）
    MASK_DILATE      mask 膨胀像素（默认 3）
    MASK_FEATHER     边缘羽化像素（默认 3）
    INPAINT_THREADS  单次推理线程数（默认 CPU 核数，设小一点可避免抢满 CPU）

接口：
    POST /inpaint  {image: base64 或 dataURL, mask: base64 或 dataURL} → {image: dataURL}
    GET  /inpaint/status
    GET  /
"""
import os
os.environ.setdefault('ORT_DISABLE_TELEMETRY', '1')

import base64
import sys
import threading

import numpy as np
import cv2
from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI(title='manga inpaint')

HOST = '127.0.0.1'
PORT = 8001          # 刻意避开 8000：那是 OCR 服务的位置

DEFAULT_MODEL = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'models', 'lama_fp32.onnx')
LAMA_MODEL = os.environ.get('LAMA_MODEL', DEFAULT_MODEL)
LAMA_MODEL_URL = os.environ.get(
    'LAMA_MODEL_URL',
    'https://huggingface.co/Carve/LaMa-ONNX/resolve/main/lama_fp32.onnx'
)
MASK_DILATE = int(os.environ.get('MASK_DILATE', '3'))
MASK_FEATHER = int(os.environ.get('MASK_FEATHER', '3'))

_lama_lock = threading.Lock()
_lama_session = None
_lama_error = None
_lama_size = None          # (w, h)；None 表示动态尺寸


class InpaintRequest(BaseModel):
    image: str                    # 纯 base64 或 dataURL
    mask: str                     # 同上；白色像素 = 要擦除的区域


def _strip_dataurl(s):
    s = (s or '').strip()
    if s.lower().startswith('data:') and ',' in s:
        return s.split(',', 1)[1]
    return s


def decode_b64_image(s):
    """接受纯 base64 或 dataURL，返回 BGR ndarray。"""
    raw = base64.b64decode(_strip_dataurl(s))
    nparr = np.frombuffer(raw, np.uint8)
    return cv2.imdecode(nparr, cv2.IMREAD_COLOR)


def decode_b64_gray(s):
    raw = base64.b64decode(_strip_dataurl(s))
    nparr = np.frombuffer(raw, np.uint8)
    return cv2.imdecode(nparr, cv2.IMREAD_GRAYSCALE)


def encode_png_dataurl(bgr):
    ok, buf = cv2.imencode('.png', bgr)
    if not ok:
        raise RuntimeError('PNG 编码失败')
    return 'data:image/png;base64,' + base64.b64encode(buf.tobytes()).decode('ascii')


def load_lama():
    """懒加载 LaMa ONNX；返回 (session, fixed_size 或 None)。失败抛异常。"""
    global _lama_session, _lama_error, _lama_size
    if _lama_session is not None:
        return _lama_session, _lama_size
    with _lama_lock:
        if _lama_session is not None:
            return _lama_session, _lama_size
        if not os.path.isfile(LAMA_MODEL):
            _lama_error = '模型不存在：%s（先跑 python %s --download-model）' % (
                LAMA_MODEL, os.path.basename(__file__))
            raise FileNotFoundError(_lama_error)
        try:
            import onnxruntime as ort
        except ImportError:
            _lama_error = '缺少 onnxruntime，请 pip install onnxruntime'
            raise RuntimeError(_lama_error)
        try:
            so = ort.SessionOptions()
            so.log_severity_level = 3
            threads = os.environ.get('INPAINT_THREADS')
            if threads and threads.isdigit() and int(threads) > 0:
                so.intra_op_num_threads = int(threads)
                so.inter_op_num_threads = 1
            sess = ort.InferenceSession(LAMA_MODEL, so, providers=['CPUExecutionProvider'])
        except Exception as e:
            _lama_error = '装载模型失败：%s' % e
            raise RuntimeError(_lama_error)

        size = None
        try:
            shape = sess.get_inputs()[0].shape
            h, w = shape[2], shape[3]
            if isinstance(h, int) and isinstance(w, int) and h > 0 and w > 0:
                size = (int(w), int(h))
        except Exception:
            size = None
        _lama_session = sess
        _lama_size = size
        _lama_error = None
        print('[inpaint] LaMa 就绪：%s  输入尺寸=%s' % (LAMA_MODEL, size or '动态'), flush=True)
        return _lama_session, _lama_size


def build_inputs(sess, image_bgr, mask_u8):
    """按模型输入签名组装张量。兼容三种常见导出方式。"""
    inputs = sess.get_inputs()
    names = [i.name for i in inputs]

    rgb = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
    t_img = np.transpose(rgb, (2, 0, 1))[None, ...]                       # 1,3,H,W
    t_msk = (mask_u8.astype(np.float32) / 255.0)[None, None, ...]         # 1,1,H,W

    if len(inputs) >= 2:
        img_name, msk_name = names[0], names[1]
        for i in inputs:
            shp = i.shape
            if len(shp) == 4 and isinstance(shp[1], int):
                if shp[1] == 1:
                    msk_name = i.name
                elif shp[1] == 3:
                    img_name = i.name
        return {img_name: t_img, msk_name: t_msk}

    first = inputs[0]
    shp = first.shape
    if len(shp) == 4 and isinstance(shp[1], int) and shp[1] == 4:
        return {first.name: np.concatenate([t_img, t_msk], axis=1)}
    return {first.name: t_img}


def _align_to_8(n):
    return max(8, (n // 8) * 8)


@app.post('/inpaint')
def inpaint(req: InpaintRequest):
    try:
        img = decode_b64_image(req.image)
        if img is None:
            raise ValueError('image 解码失败')
        msk = decode_b64_gray(req.mask)
        if msk is None:
            raise ValueError('mask 解码失败')
    except Exception as e:
        return {'error': 'bad input: %s' % e}

    try:
        sess, fixed = load_lama()
    except Exception as e:
        return {'error': str(e)}

    try:
        H, W = img.shape[:2]
        if msk.shape[:2] != (H, W):
            msk = cv2.resize(msk, (W, H), interpolation=cv2.INTER_NEAREST)

        # mask 二值化 + 膨胀（擦白边）
        msk_bin = (msk > 127).astype(np.uint8) * 255
        if MASK_DILATE > 0:
            k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (MASK_DILATE * 2 + 1,) * 2)
            msk_bin = cv2.dilate(msk_bin, k, iterations=1)

        # 尺寸对齐：固定尺寸模型先缩放，推理后缩回；动态模型对齐到 8 的倍数
        if fixed:
            tw8, th8 = _align_to_8(fixed[0]), _align_to_8(fixed[1])
        else:
            tw8, th8 = _align_to_8(W), _align_to_8(H)
        if (tw8, th8) != (W, H):
            img_in = cv2.resize(img, (tw8, th8), interpolation=cv2.INTER_LINEAR)
            msk_in = cv2.resize(msk_bin, (tw8, th8), interpolation=cv2.INTER_NEAREST)
        else:
            img_in, msk_in = img, msk_bin

        out = sess.run(None, build_inputs(sess, img_in, msk_in))[0]

        arr = np.asarray(out)
        if arr.ndim == 4:
            arr = arr[0].transpose(1, 2, 0) if arr.shape[1] == 3 else arr[0]
        arr = np.clip(arr, 0.0, 1.0) * 255.0
        out_bgr = cv2.cvtColor(arr.astype(np.uint8), cv2.COLOR_RGB2BGR)
        if out_bgr.shape[:2] != (H, W):
            out_bgr = cv2.resize(out_bgr, (W, H), interpolation=cv2.INTER_LINEAR)

        # 只在 mask 区域用生成结果，其余保留原图；边缘羽化避免硬缝
        alpha = msk_bin.astype(np.float32) / 255.0
        if MASK_FEATHER > 0:
            kf = max(1, MASK_FEATHER * 2 + 1)
            alpha = cv2.GaussianBlur(alpha, (kf, kf), 0)
        alpha = alpha[..., None]
        merged = out_bgr.astype(np.float32) * alpha + img.astype(np.float32) * (1.0 - alpha)
        merged = np.clip(merged, 0, 255).astype(np.uint8)

        return {'image': encode_png_dataurl(merged)}
    except Exception as e:
        return {'error': 'inpaint failed: %s' % e}


@app.get('/inpaint/status')
def inpaint_status():
    info = {
        'service': 'manga-inpaint',
        'model_path': LAMA_MODEL,
        'model_exists': os.path.isfile(LAMA_MODEL),
        'model_url': LAMA_MODEL_URL,
        'loaded': _lama_session is not None,
        'input_size': _lama_size,
        'dilate': MASK_DILATE,
        'feather': MASK_FEATHER,
        'error': _lama_error,
    }
    if info['model_exists'] and _lama_session is None:
        try:
            load_lama()
            info['loaded'] = True
            info['input_size'] = _lama_size
            info['error'] = None
        except Exception as e:
            info['error'] = str(e)
    elif not info['model_exists']:
        info['error'] = '模型未下载，先跑：python %s --download-model' % os.path.basename(__file__)
    return info


@app.get('/')
def root():
    return {
        'ok': True,
        'service': 'manga inpaint server',
        'port_note': '这是擦除服务，不是 OCR 服务（OCR 在 8000）',
        'model': os.path.basename(LAMA_MODEL),
        'ready': os.path.isfile(LAMA_MODEL),
        'endpoints': ['POST /inpaint', 'GET /inpaint/status'],
    }


def download_model(url=None, dst=None):
    """流式下载 LaMa ONNX（带进度、断点文件 .part）。"""
    import urllib.request
    url = url or LAMA_MODEL_URL
    dst = dst or LAMA_MODEL
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    if os.path.isfile(dst):
        print('[download] 已存在，跳过：%s (%.1f MB)' % (dst, os.path.getsize(dst) / 1048576.0), flush=True)
        return dst
    tmp = dst + '.part'
    print('[download] %s' % url, flush=True)
    print('[download] -> %s' % dst, flush=True)
    req = urllib.request.Request(url, headers={'User-Agent': 'manga-translate/7.52'})
    with urllib.request.urlopen(req, timeout=120) as resp, open(tmp, 'wb') as f:
        total = resp.headers.get('Content-Length')
        total = int(total) if total and total.isdigit() else 0
        done = 0
        while True:
            chunk = resp.read(1024 * 512)
            if not chunk:
                break
            f.write(chunk)
            done += len(chunk)
            if total:
                sys.stdout.write('\r[download] %6.2f%%  %.1f/%.1f MB' % (
                    done * 100.0 / total, done / 1048576.0, total / 1048576.0))
            else:
                sys.stdout.write('\r[download] %.1f MB' % (done / 1048576.0))
            sys.stdout.flush()
    os.replace(tmp, dst)
    print('\n[download] 完成：%s (%.1f MB)' % (dst, os.path.getsize(dst) / 1048576.0), flush=True)
    return dst


def parse_args(argv):
    opts = {'host': HOST, 'port': PORT, 'download': False, 'url': None}
    i = 1
    while i < len(argv):
        a = argv[i]
        if a == '--download-model':
            opts['download'] = True
        elif a == '--host' and i + 1 < len(argv):
            i += 1
            opts['host'] = argv[i]
        elif a == '--port' and i + 1 < len(argv):
            i += 1
            opts['port'] = int(argv[i])
        elif a == '--url' and i + 1 < len(argv):
            i += 1
            opts['url'] = argv[i]
        i += 1
    return opts


if __name__ == '__main__':
    opts = parse_args(sys.argv)
    if opts['download']:
        download_model(opts['url'])
        sys.exit(0)
    import uvicorn
    if not os.path.isfile(LAMA_MODEL):
        print('[inpaint] 未找到模型：%s' % LAMA_MODEL, flush=True)
        print('[inpaint] 擦除功能不可用；需要时运行：python %s --download-model'
              % os.path.basename(__file__), flush=True)
    print('[inpaint] 监听 http://%s:%d/inpaint（OCR 仍在 8000，互不影响）'
          % (opts['host'], opts['port']), flush=True)
    uvicorn.run(app, host=opts['host'], port=opts['port'])
