/* Motion plates. Each ink plate breathes: the plate image itself is drawn
   through a small WebGL warp that lifts and settles the mesh a few pixels,
   with the floor held still. At zero amplitude the warp is the plate, pixel
   for pixel, so the canvas can fade over the still and back off it with no
   visible handover. Nothing is downloaded beyond the still already on the
   page.

   Gates: wide viewport, no reduced-motion, no save-data, no pinned capture
   (?p=), WebGL available. The canvas is created only once the plate is on
   screen. Band and Lab plates breathe once and settle, and breathe again on
   each return; the hero keeps breathing while on screen and rests off it. */
(function () {
    'use strict';

    var MOTION = {
        /* amp: peak lift as a fraction of plate height. floor: the band of
           height-from-bottom over which the mask rises from 0 (floor and
           contours, held still) to 1 (the top of the mesh). */
        'vol-surface-1w':           { amp: 0.011, floor: [0.30, 0.62], mode: 'loop' },
        'curve-surface-3-sheet':    { amp: 0.009, floor: [0.22, 0.55], mode: 'once' },
        'vol-surface-wide-sheet':   { amp: 0.010, floor: [0.34, 0.66], mode: 'once' },
        'survival-surface-7-sheet': { amp: 0.008, floor: [0.24, 0.58], mode: 'once' }
    };
    var RAMP_IN = 2.4, HOLD = 7.0, RAMP_OUT = 3.0, DPR_CAP = 2;

    var VERT = [
        'attribute vec2 p;',
        'varying vec2 v;',
        'void main(){ v = vec2(p.x*0.5+0.5, 0.5-p.y*0.5); gl_Position = vec4(p,0.0,1.0); }'
    ].join('\n');
    var FRAG = [
        'precision mediump float;',
        'uniform sampler2D tex; uniform float t; uniform float amp; uniform vec2 floorBand;',
        'varying vec2 v;',
        'void main(){',
        '  float h = 1.0 - v.y;',
        '  float m = smoothstep(floorBand.x, floorBand.y, h);',
        '  float a = amp * m;',
        '  float dy = a * (0.62*sin(6.28318*(v.x*1.30 + t/9.0)) + 0.38*sin(6.28318*(v.x*0.70 - t/13.0) + 0.9));',
        '  float dx = a * 0.30 * sin(6.28318*(h*1.10 + t/11.0));',
        '  gl_FragColor = texture2D(tex, v + vec2(dx, dy));',
        '}'
    ].join('\n');

    function stem(src) {
        var f = src.slice(src.lastIndexOf('/') + 1);
        return f.slice(0, f.lastIndexOf('.'));
    }

    function makeGL(canvas) {
        var opts = { alpha: false, antialias: false, preserveDrawingBuffer: false };
        var gl = canvas.getContext('webgl', opts) || canvas.getContext('experimental-webgl', opts);
        if (!gl) return null;
        function sh(type, src) {
            var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
            if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) return null;
            return s;
        }
        var vs = sh(gl.VERTEX_SHADER, VERT), fs = sh(gl.FRAGMENT_SHADER, FRAG);
        if (!vs || !fs) return null;
        var prog = gl.createProgram();
        gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
        gl.useProgram(prog);
        var buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
        var loc = gl.getAttribLocation(prog, 'p');
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
        return { gl: gl, prog: prog,
                 uT: gl.getUniformLocation(prog, 't'),
                 uAmp: gl.getUniformLocation(prog, 'amp'),
                 uFloor: gl.getUniformLocation(prog, 'floorBand') };
    }

    /* The texture is the plate scaled to the canvas by the browser's own
       image scaler, so at rest the shader reads it one texel per pixel and
       the canvas is the still exactly. Sampling the full-size plate instead
       aliases the fine mesh wherever the still is shown well below its size. */
    function upload(ctx, img, w, h) {
        var gl = ctx.gl;
        var scratch = ctx.scratch || (ctx.scratch = document.createElement('canvas'));
        scratch.width = w; scratch.height = h;
        var c2 = scratch.getContext('2d');
        c2.imageSmoothingEnabled = true; c2.imageSmoothingQuality = 'high';
        c2.drawImage(img, 0, 0, w, h);
        if (!ctx.tex) ctx.tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, ctx.tex);
        gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.BROWSER_DEFAULT_WEBGL);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, scratch);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    }

    /* Amplitude envelope: a soft rise, and for a single breath a hold and a
       soft fall back to zero, so the plate is the still again before the
       canvas fades off it. */
    function envelope(mode, s) {
        var x = Math.min(1, s / RAMP_IN), up = x * x * (3 - 2 * x);
        if (mode === 'loop') return up;
        var y = Math.min(1, Math.max(0, (s - RAMP_IN - HOLD) / RAMP_OUT)), down = 1 - y * y * (3 - 2 * y);
        return up * down;
    }

    /* The WebGL work happens on a canvas that is never in the page. Each
       frame is copied onto a plain 2D canvas that is: a 2D canvas composites
       like an image inside the plates' blend, mask and filter wrappers, where
       a WebGL canvas can paint blank. */
    function Plate(img, cfg) {
        this.img = img; this.cfg = cfg; this.canvas = null; this.c2d = null;
        this.glCanvas = null; this.ctx = null;
        this.raf = 0; this.t0 = 0; this.onScreen = false; this.finished = false;
        this.ro = null;
    }
    Plate.prototype.build = function () {
        var g = document.createElement('canvas');
        var ctx = makeGL(g);
        if (!ctx) return false;
        var c = document.createElement('canvas');
        c.className = 'plate-motion';
        c.setAttribute('aria-hidden', 'true');
        this.img.parentNode.insertBefore(c, this.img.nextSibling);
        this.canvas = c; this.c2d = c.getContext('2d');
        this.glCanvas = g; this.ctx = ctx;
        ctx.gl.uniform2f(ctx.uFloor, this.cfg.floor[0], this.cfg.floor[1]);
        this.size();
        var self = this;
        if ('ResizeObserver' in window) {
            this.ro = new ResizeObserver(function () { self.size(); });
            this.ro.observe(this.img);
        }
        return true;
    };
    Plate.prototype.size = function () {
        var r = this.img.getBoundingClientRect(), d = Math.min(DPR_CAP, devicePixelRatio || 1);
        var w = Math.max(1, Math.round(r.width * d)), h = Math.max(1, Math.round(r.height * d));
        if (this.canvas.width !== w || this.canvas.height !== h || !this.ctx.tex) {
            this.canvas.width = w; this.canvas.height = h;
            this.glCanvas.width = w; this.glCanvas.height = h;
            this.ctx.gl.viewport(0, 0, w, h);
            upload(this.ctx, this.img, w, h);
            // A resize clears the canvas: put the still back at once.
            this.draw(0, 0);
        }
    };
    Plate.prototype.draw = function (s, amp) {
        var gl = this.ctx.gl;
        gl.uniform1f(this.ctx.uT, s);
        gl.uniform1f(this.ctx.uAmp, amp);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        this.c2d.drawImage(this.glCanvas, 0, 0);
    };
    Plate.prototype.frame = function (now) {
        var s = (now - this.t0) / 1000, e = envelope(this.cfg.mode, s);
        this.draw(s, this.cfg.amp * e);
        if (this.cfg.mode === 'once' && s > RAMP_IN + HOLD + RAMP_OUT) {
            this.settle(); return;
        }
        var self = this;
        this.raf = requestAnimationFrame(function (n) { self.frame(n); });
    };
    Plate.prototype.start = function () {
        if (this.raf) return;
        var self = this;
        this.t0 = performance.now();
        this.frame(this.t0);
        // First frame is the still at zero amplitude; fade the canvas over it.
        requestAnimationFrame(function () { self.canvas.classList.add('is-live'); });
    };
    Plate.prototype.pause = function () {
        if (this.raf) { cancelAnimationFrame(this.raf); this.raf = 0; }
    };
    /* A single breath is over: the frame on the canvas is the still again, so
       the fade off it shows nothing. Rendering stops until the next return. */
    Plate.prototype.settle = function () {
        this.raf = 0;
        this.canvas.classList.remove('is-live');
        this.finished = true;
    };
    Plate.prototype.enter = function () {
        this.onScreen = true;
        if (!this.canvas && !this.build()) return;
        var self = this;
        if (this.cfg.mode === 'loop') {
            if (this.canvas.classList.contains('is-live')) { if (!this.raf) { this.t0 = performance.now() - this.tPaused; this.frame(performance.now()); } }
            else setTimeout(function () { if (self.onScreen) self.start(); }, 1250);
        } else if (!this.raf) {
            setTimeout(function () { if (self.onScreen) { self.finished = false; self.start(); } }, 1000);
        }
    };
    Plate.prototype.leave = function () {
        this.onScreen = false;
        if (this.cfg.mode === 'loop' && this.raf) { this.tPaused = performance.now() - this.t0; this.pause(); }
    };

    function init() {
        var reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
        var wide = matchMedia('(min-width: 900px)').matches;
        var pinned = /[?&]p=([0-9.]+)/.test(location.search);
        var conn = navigator.connection || {};
        if (reduced || pinned || !wide || conn.saveData) return;
        if (!('IntersectionObserver' in window)) return;

        var plates = [];
        document.querySelectorAll('.plate-wipe > img').forEach(function (img) {
            var cfg = MOTION[stem(img.getAttribute('src') || '')];
            if (cfg) plates.push(new Plate(img, cfg));
        });
        if (!plates.length) return;
        window.MSPlates = plates;

        var byImg = new Map();
        plates.forEach(function (p) { byImg.set(p.img, p); });
        var io = new IntersectionObserver(function (es) {
            es.forEach(function (e) {
                var p = byImg.get(e.target);
                if (!p) return;
                if (e.isIntersecting) {
                    var go = function () { p.enter(); };
                    if (p.img.complete && p.img.naturalWidth) go();
                    else p.img.addEventListener('load', go, { once: true });
                } else {
                    p.leave();
                }
            });
        }, { threshold: 0.2 });
        plates.forEach(function (p) { io.observe(p.img); });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
