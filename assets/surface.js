/* Model Sense surface: z = f(x, y) drawn as a hairline mesh on paper in an
   orthographic three-quarter view, with real volume.

   Four things carry the depth, and each is checkable by eye at 100 percent:
     1. Stroke weight and alpha are graded by depth. A line at the far corner
        is about a third the weight and a third the alpha of the same line at
        the near corner, so the object recedes instead of lying flat.
     2. Faces are tinted by a lambert term on the face normal, paper where the
        face turns to the light, a light ink tint where it turns away. The
        folds darken because they are steep, not because they are drawn twice.
     3. The accent is a wash on the crest itself, its falloff fixed in cells
        so it dies about four cells below the rim whatever the surface does.
     4. Contours from the same z-values drop to the floor, inside a faint
        parallelogram footprint, so the object stands on something.

   Mesh density comes from the scale the object is actually drawn at, about
   eleven pixels a cell, so a thumbnail and a hero read as the same object
   rather than as a smear and a diagram. The plot-in runs front to back: the
   near corner lands first and the surface grows away from the reader, with
   the accent wash arriving last.

   No dependencies. Retina aware. Static final frame under reduced motion. */
(function (root) {
  'use strict';

  var INK = '18,19,18';
  var NODE = {
    teal: [43, 122, 120], green: [61, 122, 66],
    orange: [200, 106, 58], purple: [112, 80, 160], ink: [18, 19, 18]
  };
  var PAPER = '#FCFCFB';
  var CA = 0.866;

  function ease(t) { return t < 0 ? 0 : t > 1 ? 1 : 1 - Math.pow(1 - t, 3); }
  function clamp(t) { return t < 0 ? 0 : t > 1 ? 1 : t; }
  function smooth(t) { return t * t * (3 - 2 * t); }

  /* ---- presets ------------------------------------------------------- */
  /* Implied volatility across moneyness and expiry: a SABR-shaped smile
     that flattens and loses skew as expiry lengthens. */
  function sabr(u, v) {
    var k = -1 + 2 * u;            // log-moneyness, low strike to high
    var T = 0.08 + v * 2.5;        // expiry in years
    var atm = 0.160 + 0.145 * Math.exp(-1.05 * T);
    var smile = 0.050 * k * k / (1 + 0.30 * T);
    var skew = -0.012 * k / (1 + 0.60 * T);
    return atm + smile + skew;
  }
  /* Non-maturity deposit attrition: rate level across, balance size into
     depth, annual attrition as height. Larger balances leave earlier and
     leave faster once the incentive to move opens up. */
  function decay(u, v) {
    var r = u * 0.06;                       // short rate, 0 to 6 percent
    var size = v;                           // small balances to large
    var mid = 0.036 - 0.021 * size;
    var slope = 95 + 130 * size;
    return 0.015 + (0.10 + 0.26 * size) / (1 + Math.exp(-slope * (r - mid)));
  }

  var PRESETS = {
    sabr: { f: sabr, accent: 'teal', xLabel: 'STRIKE', yLabel: 'EXPIRY' },
    decay: { f: decay, accent: 'purple', xLabel: 'RATE LEVEL', yLabel: 'BALANCE' }
  };

  var DEF = {
    preset: null, f: sabr,
    nx: null, ny: null,      // null lets the drawn size set the density
    cellPx: 11,              // target screen size of one cell
    minN: 16, maxN: 64,
    ex: 2.20, ey: 1.25,      // world extent of the domain, wide by deep
    duration: 1150,          // whole plot-in, at or under the 1.2s ceiling
    accent: 'teal',
    tilt: 0.24, lift: 0.58,  // camera. Lower values flatten the view.
    contours: true, levels: 12, footprint: true, floorDrop: 0.12,
    crest: true,             // the accent line along the top fold
    washSpan: 1,             // widens the crest wash beyond its natural falloff
    labels: true, xLabel: 'X', yLabel: 'Y',
    pad: 20, autoplay: true,
    margin: 0,               // fit margin as a fraction of the canvas, 0 keeps pad
    rot: 0,                  // azimuth offset from the three-quarter default
    rotRange: 0,             // azimuth swing the fit must also clear, both ways
    zoom: 1, anchor: 0.5, shiftY: 0,
    paper: PAPER,            // the ground the object is painted onto
    fadeTop: 0,              // paper gradient over the top N px of the canvas
    ink: 1                   // overall weight of the mesh
  };

  /* Ink strength buckets. m runs from the far hairline to the near fold, and
     both alpha and width are proportional to it, so far over near lands at
     about a third on each. */
  var NBUCK = 7, A_INK = 0.66, W_INK = 1.35, W_MIN = 0.40;
  var NTINT = 8, TINT_MAX = 0.23;    // lambert face tint, paper to light ink
  var NWASH = 9, WASH_MAX = 0.60;    // accent wash on the crest
  var NBAND = 46;                    // depth bands, painted far to near

  function Surface(canvas, opts) {
    var o = {}, k;
    for (k in DEF) o[k] = DEF[k];
    if (opts && opts.preset && PRESETS[opts.preset]) {
      var p = PRESETS[opts.preset];
      for (k in p) o[k] = p[k];
    }
    for (k in (opts || {})) if (opts[k] != null) o[k] = opts[k];
    this.c = canvas;
    this.ctx = canvas.getContext('2d');
    this.o = o;
    this.autoN = (opts == null || opts.nx == null);
    this.cam();
    this.measure();
    o.nx = o.nx || 32;
    o.ny = o.ny || Math.max(8, Math.round(o.nx * o.ey / o.ex));
    this.grid();
    this.fit();
    if (this.autoN) { this.density(); this.grid(); this.fit(); }
  }

  /* Re-measure the element and refit at the size it now has. Same order as
     the constructor: fit once to learn the scale, let the scale set the
     density, then rebuild and fit again. */
  Surface.prototype.resize = function () {
    this.measure();
    this.fit();
    if (this.autoN) { this.density(); this.grid(); this.fit(); }
    return this;
  };

  Surface.prototype.measure = function () {
    var c = this.c;
    this.w = c.clientWidth || parseInt(c.getAttribute('width'), 10) || 600;
    this.h = c.clientHeight || parseInt(c.getAttribute('height'), 10) || 360;
  };

  /* One step in u moves this far on screen, so the line count follows from
     the scale the object was actually fitted at. A thumbnail and a hero then
     carry cells of the same size, which is what makes them the same object. */
  Surface.prototype.density = function () {
    var o = this.o;
    var step = this.s * Math.sqrt(CA * CA + o.tilt * o.tilt);
    o.nx = Math.max(o.minN, Math.min(o.maxN, Math.round(step * o.ex / o.cellPx)));
    o.ny = Math.max(8, Math.round(o.nx * o.ey / o.ex));
  };

  /* The camera is a general axonometric one: azimuth A around the vertical,
     an anisotropic scale on each screen axis, and the height read straight
     off z. At rot = 0 it reduces exactly to the three-quarter view the
     object was drawn in before, (x - y) across and (x + y) into depth. */
  Surface.prototype.cam = function () {
    var o = this.o, A = Math.PI / 4 + (o.rot || 0);
    var kx = CA / Math.SQRT1_2, ky = o.tilt / Math.SQRT1_2;
    this.cx = Math.cos(A) * kx; this.sx = Math.sin(A) * kx;
    this.cy = Math.cos(A) * ky; this.sy = Math.sin(A) * ky;
  };

  Surface.prototype.raw = function (u, v, z) {
    var o = this.o, x = (u - 0.5) * o.ex, y = (v - 0.5) * o.ey;
    return [x * this.cx - y * this.sx, x * this.sy + y * this.cy - z * o.lift];
  };

  /* Swing the azimuth without refitting. The fit already cleared the whole
     rotRange, so the object turns inside a box it can never leave and the
     scale never breathes. */
  Surface.prototype.setRot = function (r) {
    this.o.rot = r;
    this.cam();
    this.project();
    return this;
  };

  /* ---- field --------------------------------------------------------- */

  Surface.prototype.grid = function () {
    var o = this.o, z = [], lo = Infinity, hi = -Infinity, i, j;
    for (i = 0; i <= o.nx; i++) {
      z[i] = [];
      for (j = 0; j <= o.ny; j++) {
        var val = o.f(i / o.nx, j / o.ny);
        z[i][j] = val;
        if (val < lo) lo = val;
        if (val > hi) hi = val;
      }
    }
    var span = (hi - lo) || 1;
    for (i = 0; i <= o.nx; i++) {
      for (j = 0; j <= o.ny; j++) z[i][j] = (z[i][j] - lo) / span;
    }
    this.z = z;

    /* How far the crest wash reaches, fixed in cells rather than in height,
       so a plateau and a smile both fade over about four cells. On the
       descending shoulder, measure the height a cell of travel costs. */
    var acc = 0, n = 0;
    for (i = 0; i < o.nx; i++) {
      for (j = 0; j < o.ny; j++) {
        var hh = 0.25 * (z[i][j] + z[i + 1][j] + z[i][j + 1] + z[i + 1][j + 1]);
        if (hh < 0.45 || hh > 0.97) continue;
        var a = z[i + 1][j] - z[i][j], b = z[i][j + 1] - z[i][j];
        acc += Math.sqrt(a * a + b * b);
        n++;
      }
    }
    var gc = n ? acc / n : 0.05;
    this.delta = Math.max(0.30, Math.min(0.55, 4.0 * gc)) * o.washSpan;

    this.floorIso = this.contourSet();
    this.crestLevel = 1 - this.delta * 0.55;
    this.crestIso = o.crest ? this.iso(this.crestLevel, 1) : [];

    // The field changed, so the node buffers and the band topology built on
    // it are both stale.
    this.X = null; this.bands = null;
  };

  /* Marching squares on the normalised field. Returns fractional cell
     coordinates, so the same routine serves the floor contours and the
     accent line on the crest. */
  Surface.prototype.iso = function (level, step) {
    var o = this.o, z = this.z, out = [], i, j, e;
    for (i = 0; i + step <= o.nx; i += step) {
      for (j = 0; j + step <= o.ny; j += step) {
        var cs = [
          [i, j, i + step, j], [i + step, j, i + step, j + step],
          [i + step, j + step, i, j + step], [i, j + step, i, j]
        ], hits = [], a, b, t;
        for (e = 0; e < 4; e++) {
          a = z[cs[e][0]][cs[e][1]];
          b = z[cs[e][2]][cs[e][3]];
          if ((a - level) * (b - level) < 0) {
            t = (level - a) / (b - a);
            hits.push([
              cs[e][0] + (cs[e][2] - cs[e][0]) * t,
              cs[e][1] + (cs[e][3] - cs[e][1]) * t
            ]);
          }
        }
        for (e = 0; e + 1 < hits.length; e += 2) {
          out.push([hits[e][0], hits[e][1], hits[e + 1][0], hits[e + 1][1]]);
        }
      }
    }
    return out;
  };

  Surface.prototype.contourSet = function () {
    var o = this.o, step = Math.max(1, Math.round(o.nx / 40)), all = [], n;
    for (n = 1; n <= o.levels; n++) {
      all.push({ L: n / (o.levels + 1), segs: this.iso(n / (o.levels + 1), step) });
    }
    return all;
  };

  /* ---- projection and batching --------------------------------------- */

  Surface.prototype.pt = function (i, j, z) {
    var o = this.o;
    var q = this.raw(i / o.nx, j / o.ny, z == null ? this.zAt(i, j) : z);
    return [this.ox + q[0] * this.s, this.oy + q[1] * this.s];
  };

  Surface.prototype.zAt = function (i, j) {
    var o = this.o;
    var i0 = Math.floor(i), j0 = Math.floor(j);
    var i1 = Math.min(o.nx, i0 + 1), j1 = Math.min(o.ny, j0 + 1);
    var fi = i - i0, fj = j - j0;
    return (this.z[i0][j0] * (1 - fi) + this.z[i1][j0] * fi) * (1 - fj) +
           (this.z[i0][j1] * (1 - fi) + this.z[i1][j1] * fi) * fj;
  };

  Surface.prototype.fit = function () {
    var o = this.o, c = this.c;
    var dpr = Math.min(root.devicePixelRatio || 1, 2);
    c.width = Math.round(this.w * dpr);
    c.height = Math.round(this.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    /* The bounding box is the union over the azimuth swing the idle rotation
       will use, and it takes in the floor as well as the crest: the footprint
       and its contours sit at -floorDrop, which is the lowest thing drawn.
       Fitting the union means the whole object clears the frame at every
       angle it will ever be seen at, with one fixed scale. */
    var R = o.rotRange || 0, keep = o.rot;
    var probes = R ? [-R, -R * 0.5, 0, R * 0.5, R] : [0];
    var x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, i, j, q, n;
    for (n = 0; n < probes.length; n++) {
      o.rot = probes[n]; this.cam();
      for (i = 0; i <= o.nx; i++) {
        for (j = 0; j <= o.ny; j++) {
          q = this.raw(i / o.nx, j / o.ny, this.z[i][j]);
          if (q[0] < x0) x0 = q[0]; if (q[0] > x1) x1 = q[0];
          if (q[1] < y0) y0 = q[1]; if (q[1] > y1) y1 = q[1];
          q = this.raw(i / o.nx, j / o.ny, -o.floorDrop);
          if (q[0] < x0) x0 = q[0]; if (q[0] > x1) x1 = q[0];
          if (q[1] < y0) y0 = q[1]; if (q[1] > y1) y1 = q[1];
        }
      }
    }
    o.rot = keep; this.cam();

    var mx = Math.max(o.pad, this.w * o.margin);
    var my = Math.max(o.pad, this.h * o.margin);
    var padB = o.labels ? my + 16 : my;
    var s = Math.min((this.w - 2 * mx) / (x1 - x0),
                     (this.h - my - padB) / (y1 - y0)) * o.zoom;
    this.s = s;
    this.ox = (this.w - (x1 - x0) * s) / 2 - x0 * s;
    this.oy = my + (this.h - my - padB - (y1 - y0) * s) * o.anchor
              - y0 * s + o.shiftY;
    this.project();
  };

  /* Fill a band's quad buffer from its cell index list. */
  function quads(idx, out, X, Y, ny) {
    for (var k = 0, p = 0, L = idx.length; k < L; k++) {
      var c = idx[k], i = (c / ny) | 0, j = c - i * ny, i1 = i + 1, j1 = j + 1;
      out[p++] = X[i][j];   out[p++] = Y[i][j];
      out[p++] = X[i1][j];  out[p++] = Y[i1][j];
      out[p++] = X[i1][j1]; out[p++] = Y[i1][j1];
      out[p++] = X[i][j1];  out[p++] = Y[i][j1];
    }
  }
  /* Same for a segment buffer. The low bit of the index is the direction. */
  function segments(idx, out, X, Y, ny1) {
    for (var k = 0, p = 0, L = idx.length; k < L; k++) {
      var e = idx[k], dir = e & 1, c = e >> 1;
      var i = (c / ny1) | 0, j = c - i * ny1;
      var i2 = dir ? i : i + 1, j2 = dir ? j + 1 : j;
      out[p++] = X[i][j];   out[p++] = Y[i][j];
      out[p++] = X[i2][j2]; out[p++] = Y[i2][j2];
    }
  }

  /* Project every node, then hand the band buffers their screen coordinates.

     Which cell belongs to which depth band, tint step and wash step is a
     property of the field, not of the camera, so it is settled once in
     topology(). Turning the object then costs one pass over the nodes and
     one pass writing into buffers that already exist: no allocation and
     nothing re-sorted, which is what keeps the idle rotation cheap. */
  Surface.prototype.project = function () {
    var o = this.o, X = this.X, Y = this.Y, i, j, x, y;
    if (!X) {
      X = []; Y = [];
      for (i = 0; i <= o.nx; i++) {
        X[i] = new Float32Array(o.ny + 1);
        Y[i] = new Float32Array(o.ny + 1);
      }
      this.X = X; this.Y = Y;
    }
    for (i = 0; i <= o.nx; i++) {
      x = (i / o.nx - 0.5) * o.ex;
      for (j = 0; j <= o.ny; j++) {
        y = (j / o.ny - 0.5) * o.ey;
        X[i][j] = this.ox + (x * this.cx - y * this.sx) * this.s;
        Y[i][j] = this.oy +
          (x * this.sy + y * this.cy - this.z[i][j] * o.lift) * this.s;
      }
    }
    if (!this.bands) this.topology();
    this.place();
  };

  Surface.prototype.place = function () {
    var o = this.o, X = this.X, Y = this.Y, ny = o.ny, ny1 = o.ny + 1, b, n, band;
    for (b = 0; b < this.NB; b++) {
      band = this.bands[b];
      quads(band.qi, band.paper, X, Y, ny);
      for (n = 0; n < NTINT; n++) quads(band.ti[n], band.tint[n], X, Y, ny);
      for (n = 0; n < NWASH; n++) quads(band.wi[n], band.wash[n], X, Y, ny);
      for (n = 0; n < NBUCK; n++) segments(band.si[n], band.segs[n], X, Y, ny1);
    }
  };

  /* Sort the mesh into depth bands. Each band paints paper, its lambert tint,
     its share of the accent wash, and its segments in seven weight buckets.
     Painting the bands far to near lets near geometry hide far geometry with
     no z-buffer, and the whole mesh still costs a few hundred draw calls
     however dense it is. */
  Surface.prototype.topology = function () {
    var o = this.o, i, j, b, k, m;
    var D = o.nx + o.ny, NB = Math.min(NBAND, D), ny = o.ny, ny1 = o.ny + 1;
    var bands = [], band;
    for (b = 0; b < NB; b++) {
      band = { qi: [], ti: [], wi: [], si: [] };
      for (k = 0; k < NTINT; k++) band.ti.push([]);
      for (k = 0; k < NWASH; k++) band.wi.push([]);
      for (k = 0; k < NBUCK; k++) band.si.push([]);
      bands.push(band);
    }
    function bandOf(d) { return Math.min(NB - 1, Math.floor(d / D * NB)); }

    /* Slope magnitude per node, normalised, for the secondary weight on the
       folds. Depth is what does the heavy lifting. */
    var z = this.z, G = [], gmax = 0;
    for (i = 0; i <= o.nx; i++) {
      G[i] = [];
      for (j = 0; j <= o.ny; j++) {
        var da = z[Math.min(o.nx, i + 1)][j] - z[Math.max(0, i - 1)][j];
        var db = z[i][Math.min(o.ny, j + 1)] - z[i][Math.max(0, j - 1)];
        m = Math.sqrt(da * da + db * db) * o.nx * 0.5;
        G[i][j] = m;
        if (m > gmax) gmax = m;
      }
    }
    for (i = 0; i <= o.nx; i++) {
      for (j = 0; j <= o.ny; j++) G[i][j] = Math.sqrt(G[i][j] / (gmax || 1));
    }
    this.g = G;

    /* Light from above, a little behind and to the left, so faces that turn
       away from the reader take the tint and flat ground stays paper. */
    var LX = -0.30, LY = -0.42, LZ = 0.86;
    var cut = 1 - this.delta;

    for (i = 0; i <= o.nx; i++) {
      for (j = 0; j <= o.ny; j++) {
        var d = i + j, bb = bandOf(d), dn = d / D, node = i * ny1 + j;
        var fd = 0.34 + 0.66 * dn;              // the depth grade
        if (i < o.nx) {
          m = clamp(fd * (0.72 + 0.45 * 0.5 * (G[i][j] + G[i + 1][j])));
          k = Math.min(NBUCK - 1, Math.floor(m * NBUCK));
          bands[bb].si[k].push(node * 2);
        }
        if (j < o.ny) {
          m = clamp(fd * (0.72 + 0.45 * 0.5 * (G[i][j] + G[i][j + 1])));
          k = Math.min(NBUCK - 1, Math.floor(m * NBUCK));
          bands[bb].si[k].push(node * 2 + 1);
        }
        if (i < o.nx && j < o.ny) {
          var cell = i * ny + j;
          bands[bb].qi.push(cell);

          // Face normal in world units, where z is scaled by the camera lift.
          var zu = (z[i + 1][j] - z[i][j] + z[i + 1][j + 1] - z[i][j + 1])
                   * 0.5 * (o.nx / o.ex) * o.lift;
          var zv = (z[i][j + 1] - z[i][j] + z[i + 1][j + 1] - z[i + 1][j])
                   * 0.5 * (o.ny / o.ey) * o.lift;
          var nl = Math.sqrt(zu * zu + zv * zv + 1);
          var lam = clamp((-zu * LX - zv * LY + LZ) / nl);
          var tint = Math.pow(1 - lam, 1.55);
          k = Math.min(NTINT - 1, Math.floor(tint * NTINT));
          if (k > 0) bands[bb].ti[k].push(cell);

          // The crest wash, cut so it dies three or four cells off the top.
          var hh = 0.25 * (z[i][j] + z[i + 1][j] + z[i][j + 1] + z[i + 1][j + 1]);
          var a = clamp((hh - cut) / this.delta);
          a = a * a * (3 - 2 * a);
          if (a > 0.06) {
            k = Math.min(NWASH - 1, Math.floor(a * NWASH));
            bands[bb].wi[k].push(cell);
          }
        }
      }
    }
    function ints(a) { return new Int32Array(a); }
    function buf(n) { return function (a) { return new Float32Array(a.length * n); }; }
    for (b = 0; b < NB; b++) {
      band = bands[b];
      band.qi = ints(band.qi);
      band.paper = new Float32Array(band.qi.length * 8);
      band.ti = band.ti.map(ints); band.tint = band.ti.map(buf(8));
      band.wi = band.wi.map(ints); band.wash = band.wi.map(buf(8));
      band.si = band.si.map(ints); band.segs = band.si.map(buf(4));
      band.d0 = b / NB * D;
      band.d1 = (b + 1) / NB * D;
    }
    this.bands = bands;
    this.NB = NB;
    this.D = D;
  };

  /* ---- floor --------------------------------------------------------- */

  Surface.prototype.floor = function (alpha) {
    var o = this.o, ctx = this.ctx, i, n, e, p1, p2, seg, F = -o.floorDrop;
    if (alpha <= 0) return;
    ctx.save();
    ctx.globalAlpha = alpha;

    if (o.footprint) {
      var corners = [[0, 0], [o.nx, 0], [o.nx, o.ny], [0, o.ny]];
      ctx.beginPath();
      for (i = 0; i < 4; i++) {
        p1 = this.pt(corners[i][0], corners[i][1], F);
        if (i === 0) ctx.moveTo(p1[0], p1[1]); else ctx.lineTo(p1[0], p1[1]);
      }
      ctx.closePath();
      ctx.fillStyle = 'rgba(' + INK + ',0.028)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(' + INK + ',0.20)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    if (o.contours) {
      ctx.lineWidth = 0.75;
      for (n = 0; n < this.floorIso.length; n++) {
        seg = this.floorIso[n].segs;
        // The high contours ring the crest; draw those a shade firmer.
        ctx.strokeStyle = 'rgba(' + INK + ',' +
          (0.20 + 0.20 * this.floorIso[n].L).toFixed(3) + ')';
        ctx.beginPath();
        for (e = 0; e < seg.length; e++) {
          p1 = this.pt(seg[e][0], seg[e][1], F);
          p2 = this.pt(seg[e][2], seg[e][3], F);
          ctx.moveTo(p1[0], p1[1]);
          ctx.lineTo(p2[0], p2[1]);
        }
        ctx.stroke();
      }
    }
    ctx.restore();
  };

  /* ---- surface ------------------------------------------------------- */

  /* front: how far the mesh has grown back from the near corner, in d units.
     Bands still paint far to near; only the revealed set changes. */
  Surface.prototype.paint = function (front, washA) {
    var ctx = this.ctx, o = this.o, acc = NODE[o.accent] || NODE.teal;
    var b, k, a, col, mix, band, alpha, n, edge = this.D - front;
    for (b = 0; b < this.NB; b++) {
      band = this.bands[b];
      if (band.d1 < edge) continue;
      alpha = band.d0 >= edge ? 1 : ease((band.d1 - edge) / (band.d1 - band.d0));
      ctx.save();
      ctx.globalAlpha = alpha;

      a = band.paper;
      ctx.beginPath();
      for (k = 0; k < a.length; k += 8) {
        ctx.moveTo(a[k], a[k + 1]);
        ctx.lineTo(a[k + 2], a[k + 3]);
        ctx.lineTo(a[k + 4], a[k + 5]);
        ctx.lineTo(a[k + 6], a[k + 7]);
        ctx.closePath();
      }
      ctx.fillStyle = o.paper;
      ctx.fill();

      for (n = 1; n < NTINT; n++) {
        a = band.tint[n];
        if (!a.length) continue;
        ctx.beginPath();
        for (k = 0; k < a.length; k += 8) {
          ctx.moveTo(a[k], a[k + 1]);
          ctx.lineTo(a[k + 2], a[k + 3]);
          ctx.lineTo(a[k + 4], a[k + 5]);
          ctx.lineTo(a[k + 6], a[k + 7]);
          ctx.closePath();
        }
        ctx.fillStyle = 'rgba(' + INK + ',' +
          (TINT_MAX * (n + 0.5) / NTINT).toFixed(3) + ')';
        ctx.fill();
      }

      if (washA > 0) {
        for (n = 0; n < NWASH; n++) {
          a = band.wash[n];
          if (!a.length) continue;
          mix = 0.04 + 0.26 * (n / (NWASH - 1));   // deepens toward the rim
          col = [Math.round(acc[0] * (1 - mix) + 18 * mix),
                 Math.round(acc[1] * (1 - mix) + 19 * mix),
                 Math.round(acc[2] * (1 - mix) + 18 * mix)];
          ctx.beginPath();
          for (k = 0; k < a.length; k += 8) {
            ctx.moveTo(a[k], a[k + 1]);
            ctx.lineTo(a[k + 2], a[k + 3]);
            ctx.lineTo(a[k + 4], a[k + 5]);
            ctx.lineTo(a[k + 6], a[k + 7]);
            ctx.closePath();
          }
          ctx.fillStyle = 'rgba(' + col.join(',') + ',' +
            (WASH_MAX * (n + 0.5) / NWASH * washA).toFixed(3) + ')';
          ctx.fill();
        }
      }

      for (n = 0; n < NBUCK; n++) {
        a = band.segs[n];
        if (!a.length) continue;
        var m = (n + 0.5) / NBUCK;
        ctx.beginPath();
        for (k = 0; k < a.length; k += 4) {
          ctx.moveTo(a[k], a[k + 1]);
          ctx.lineTo(a[k + 2], a[k + 3]);
        }
        ctx.strokeStyle = 'rgba(' + INK + ',' + (A_INK * m * o.ink).toFixed(3) + ')';
        ctx.lineWidth = Math.max(W_MIN, W_INK * m);
        ctx.stroke();
      }
      ctx.restore();
    }
  };

  /* The domain boundary, which gives the object its silhouette. Its weight is
     graded by depth for the same reason the mesh is, and it takes the accent
     where the rim itself is inside the wash, which is where a smile carries
     its crest: on the edge of the domain rather than on an interior fold. */
  Surface.prototype.edge = function (front, washA) {
    var o = this.o, ctx = this.ctx, i, j, p, prev = null, pz = 0;
    var acc = NODE[o.accent] || NODE.teal;
    var walk = [], edge = this.D - front;
    for (i = 0; i <= o.nx; i++) walk.push([i, 0]);
    for (j = 1; j <= o.ny; j++) walk.push([o.nx, j]);
    for (i = o.nx - 1; i >= 0; i--) walk.push([i, o.ny]);
    for (j = o.ny - 1; j >= 1; j--) walk.push([0, j]);
    walk.push([0, 0]);
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (i = 0; i < walk.length; i++) {
      var a = walk[i], d = a[0] + a[1], zz = this.z[a[0]][a[1]];
      if (d < edge) { prev = null; continue; }
      p = [this.X[a[0]][a[1]], this.Y[a[0]][a[1]]];
      if (prev) {
        var hot = clamp((0.5 * (zz + pz) - this.crestLevel) /
                        (1 - this.crestLevel)) * washA;
        var wt = 0.22 + 0.55 * (d / this.D);
        ctx.beginPath();
        ctx.moveTo(prev[0], prev[1]);
        ctx.lineTo(p[0], p[1]);
        ctx.strokeStyle = 'rgba(' + INK + ',' + (wt * o.ink).toFixed(3) + ')';
        ctx.lineWidth = 1.1;
        ctx.stroke();
        if (hot > 0.02) {
          ctx.strokeStyle = 'rgba(' + acc.join(',') + ',' + (0.88 * hot).toFixed(3) + ')';
          ctx.lineWidth = 1.6;
          ctx.stroke();
        }
      }
      prev = p; pz = zz;
    }
    ctx.restore();
  };

  /* The accent line where the wash meets the top of the surface. It is a
     contour of the same field, so it belongs to the object. */
  Surface.prototype.crestLine = function (front, alpha) {
    var ctx = this.ctx, o = this.o, acc = NODE[o.accent] || NODE.teal;
    if (!o.crest || alpha <= 0 || !this.crestIso.length) return;
    var edge = this.D - front, e, s, p1, p2;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = 'rgba(' + acc.join(',') + ',0.85)';
    ctx.lineWidth = 1.5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (e = 0; e < this.crestIso.length; e++) {
      s = this.crestIso[e];
      if (s[0] + s[1] < edge) continue;
      p1 = this.pt(s[0], s[1]);
      p2 = this.pt(s[2], s[3]);
      ctx.moveTo(p1[0], p1[1]);
      ctx.lineTo(p2[0], p2[1]);
    }
    ctx.stroke();
    ctx.restore();
  };

  Surface.prototype.labelAxes = function (alpha) {
    var o = this.o, ctx = this.ctx;
    if (alpha <= 0) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = '600 11px Sora, system-ui, sans-serif';
    ctx.fillStyle = 'rgba(' + INK + ',0.50)';
    var a = this.pt(o.nx / 2, o.ny, -o.floorDrop);
    ctx.textAlign = 'right'; ctx.textBaseline = 'top';
    ctx.fillText(o.xLabel.split('').join(' '), a[0] - 10, a[1] + 6);
    var b = this.pt(o.nx, o.ny / 2, -o.floorDrop), t = o.yLabel.split('').join(' ');
    ctx.textAlign = 'left';
    ctx.fillText(t, Math.min(b[0] + 10, this.w - 4 - ctx.measureText(t).width), b[1] + 6);
    ctx.restore();
  };

  /* A hero that outgrows its band is cut left and right by the frame, which
     reads as cropping. A crest cut by a horizontal edge reads as clipping,
     so the top dissolves into paper instead. */
  Surface.prototype.fade = function () {
    var o = this.o, ctx = this.ctx;
    if (!o.fadeTop) return;
    var g = ctx.createLinearGradient(0, 0, 0, o.fadeTop);
    g.addColorStop(0, o.paper);
    g.addColorStop(0.55, 'rgba(252,252,251,0.72)');
    g.addColorStop(1, 'rgba(252,252,251,0)');
    ctx.save();
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, this.w, o.fadeTop);
    ctx.restore();
  };

  /* ---- render -------------------------------------------------------- */

  Surface.prototype.render = function (p) {
    var o = this.o, ctx = this.ctx;
    this.p = p;
    ctx.clearRect(0, 0, this.w, this.h);
    var D = this.D, K = D * 0.10;

    // The floor is laid first, then the mesh grows back over it from the
    // near corner, and only then does the accent arrive.
    this.floor(ease(clamp(p / 0.30)) * 0.95);
    var front = smooth(clamp((p - 0.04) / 0.80)) * (D + K);
    var washA = ease(clamp((p - 0.62) / 0.36));
    this.paint(front, washA);
    this.edge(front, washA);
    this.crestLine(front, washA);
    if (o.labels) this.labelAxes(ease(clamp((p - 0.55) / 0.35)));
    this.fade();
  };

  Surface.prototype.start = function () {
    var self = this, o = this.o;
    if (root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      this.render(1);
      return this;
    }
    var t0 = null;
    function step(ts) {
      if (t0 === null) t0 = ts;
      var p = Math.min(1, (ts - t0) / o.duration);
      self.render(p);
      if (p < 1) root.requestAnimationFrame(step);
    }
    root.requestAnimationFrame(step);
    return this;
  };

  Surface.prototype.still = function () { this.render(1); return this; };
  Surface.prototype.at = function (p) { this.render(p); return this; };

  function create(canvas, opts) {
    var s = new Surface(canvas, opts);
    if (s.o.autoplay) s.start(); else s.still();
    return s;
  }

  root.MSSurface = { create: create, Surface: Surface, presets: PRESETS };
})(typeof window !== 'undefined' ? window : this);
