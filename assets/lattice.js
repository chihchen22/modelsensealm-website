/* Model Sense lattice: the one recurring brand geometry.
   A thin node network read off the logo mark, drawn as curved hairlines
   between seeded nodes with dots in a single node colour. It sits behind
   a band, runs off an edge, and can cut an image on a faceted edge.
   No dependencies. Same seed gives the same lattice every time. */
(function (root) {
  'use strict';

  var NS = 'http://www.w3.org/2000/svg';
  var NODE = {
    teal: '#2B7A78', green: '#3D7A42',
    orange: '#C86A3A', purple: '#7050A0', ink: '#121312'
  };

  function rand(seed) {
    var s = seed >>> 0;
    return function () {
      s = (s + 0x6D2B79F5) | 0;
      var t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  var DEF = {
    seed: 20260902,
    width: 640, height: 320,
    cell: 74,          // node spacing
    jitter: 0.30,      // share of a cell each node may wander
    curve: 0.16,       // how far an edge bows off a straight line
    opacity: 0.10,     // ink alpha for the hairlines, 0.08 to 0.12
    stroke: 1,
    bleed: 1.2,        // generate past the frame so the network runs off it
    dots: 'teal',      // one node colour, or null for lines alone
    dotDensity: 0.28,
    dotRadius: 2.6,
    draw: false,       // add the plot-in classes from motion.css
    clip: null,        // { from:'right'|'left'|'bottom', at:0.62, soft:0.16 }
    image: null        // { href, x, y, width, height } clipped by the lattice
  };

  function build(o) {
    var rnd = rand(o.seed);
    var c = o.cell, rowH = c * 0.866;
    var mx = c * o.bleed, my = rowH * o.bleed;
    var cols = Math.ceil((o.width + 2 * mx) / c) + 1;
    var rows = Math.ceil((o.height + 2 * my) / rowH) + 1;
    var P = [];
    for (var j = 0; j <= rows; j++) {
      P[j] = [];
      for (var i = 0; i <= cols; i++) {
        P[j][i] = {
          x: -mx + (i + (j % 2 ? 0.5 : 0)) * c + (rnd() - 0.5) * 2 * o.jitter * c,
          y: -my + j * rowH + (rnd() - 0.5) * 2 * o.jitter * rowH,
          r: rnd()
        };
      }
    }
    var at = function (i, j) { return (P[j] && P[j][i]) || null; };
    var edges = [], tris = [];
    for (j = 0; j < rows; j++) {
      for (i = 0; i < cols; i++) {
        var a = at(i, j), b = at(i + 1, j);
        var lo = j % 2 ? i : i - 1;       // left child on the row below
        var d1 = at(lo, j + 1), d2 = at(lo + 1, j + 1);
        if (a && b) edges.push([a, b, rnd()]);
        if (a && d1) edges.push([a, d1, rnd()]);
        if (a && d2) edges.push([a, d2, rnd()]);
        if (a && b && d2) tris.push([a, b, d2]);
        if (a && d1 && d2) tris.push([a, d1, d2]);
      }
    }
    return { pts: P, edges: edges, tris: tris, rows: rows, cols: cols };
  }

  function edgePath(e, o) {
    var a = e[0], b = e[1];
    var mxp = (a.x + b.x) / 2, myp = (a.y + b.y) / 2;
    var dx = b.x - a.x, dy = b.y - a.y;
    var bow = (e[2] - 0.5) * 2 * o.curve;
    return 'M' + a.x.toFixed(1) + ' ' + a.y.toFixed(1) +
           'Q' + (mxp - dy * bow).toFixed(1) + ' ' + (myp + dx * bow).toFixed(1) +
           ' ' + b.x.toFixed(1) + ' ' + b.y.toFixed(1);
  }

  function triPath(t) {
    return 'M' + t[0].x.toFixed(1) + ' ' + t[0].y.toFixed(1) +
           'L' + t[1].x.toFixed(1) + ' ' + t[1].y.toFixed(1) +
           'L' + t[2].x.toFixed(1) + ' ' + t[2].y.toFixed(1) + 'Z';
  }

  function keep(t, o) {
    var cl = o.clip, w = o.width, h = o.height;
    var cx = (t[0].x + t[1].x + t[2].x) / 3;
    var cy = (t[0].y + t[1].y + t[2].y) / 3;
    var wob = ((t[0].r + t[1].r) / 2 - 0.5) * 2 * (cl.soft == null ? 0.16 : cl.soft);
    var atv = (cl.at == null ? 0.62 : cl.at) + wob;
    if (cl.from === 'left') return cx / w > 1 - atv;
    if (cl.from === 'bottom') return cy / h < atv;
    return cx / w < atv;
  }

  function el(name, attrs) {
    var n = document.createElementNS(NS, name);
    for (var k in attrs) if (attrs[k] != null) n.setAttribute(k, attrs[k]);
    return n;
  }

  function svg(opts) {
    var o = {}, k;
    for (k in DEF) o[k] = DEF[k];
    for (k in (opts || {})) o[k] = opts[k];

    var g = build(o);
    var s = el('svg', {
      width: o.width, height: o.height,
      viewBox: '0 0 ' + o.width + ' ' + o.height,
      class: 'ms-lattice', 'aria-hidden': 'true', focusable: 'false'
    });
    s.style.overflow = 'visible';

    var uid = 'msl' + (o.seed >>> 0).toString(36) + Math.floor(o.width);

    if (o.clip && o.image) {
      var cp = el('clipPath', { id: uid + 'c', clipPathUnits: 'userSpaceOnUse' });
      for (var i = 0; i < g.tris.length; i++) {
        if (keep(g.tris[i], o)) cp.appendChild(el('path', { d: triPath(g.tris[i]) }));
      }
      var defs = el('defs', {});
      defs.appendChild(cp);
      s.appendChild(defs);
      s.appendChild(el('image', {
        href: o.image.href, 'xlink:href': o.image.href,
        x: o.image.x || 0, y: o.image.y || 0,
        width: o.image.width || o.width, height: o.image.height || o.height,
        preserveAspectRatio: 'xMidYMid slice',
        'clip-path': 'url(#' + uid + 'c)'
      }));
    }

    var lines = el('g', {
      fill: 'none', stroke: NODE.ink, 'stroke-width': o.stroke,
      'stroke-opacity': o.opacity, 'stroke-linecap': 'round'
    });
    for (var e = 0; e < g.edges.length; e++) {
      var p = el('path', { d: edgePath(g.edges[e], o) });
      if (o.draw) {
        p.setAttribute('class', 'ms-draw');
        p.style.setProperty('--ms-len', '160');
        p.style.setProperty('--ms-d', (e % 14) * 40 + 'ms');
      }
      lines.appendChild(p);
    }
    s.appendChild(lines);

    if (o.dots) {
      var dg = el('g', { fill: NODE[o.dots] || o.dots });
      for (var j = 0; j <= g.rows; j++) {
        for (var c2 = 0; c2 <= g.cols; c2++) {
          var pt = g.pts[j][c2];
          if (pt.r > o.dotDensity) continue;
          var d = el('circle', {
            cx: pt.x.toFixed(1), cy: pt.y.toFixed(1),
            r: (o.dotRadius * (0.75 + pt.r * 2)).toFixed(1),
            'fill-opacity': 0.85
          });
          if (o.draw) d.setAttribute('class', 'ms-draw-dot');
          dg.appendChild(d);
        }
      }
      s.appendChild(dg);
    }
    return s;
  }

  function create(container, opts) {
    var o = opts || {};
    if (!o.width) o.width = container.clientWidth || DEF.width;
    if (!o.height) o.height = container.clientHeight || DEF.height;
    var s = svg(o);
    container.appendChild(s);
    return s;
  }

  root.MSLattice = { create: create, svg: svg, colors: NODE };
})(typeof window !== 'undefined' ? window : this);
