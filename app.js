/* Guitar Tuner — YIN pitch detection on the mic signal, all in the page. */
(function () {
  "use strict";
  var $ = S3.$, $$ = S3.$$;
  var NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
  var TUNINGS = [
    { id: "std", name: "Guitar · Standard (E A D G B E)", notes: [40, 45, 50, 55, 59, 64] },
    { id: "dropd", name: "Guitar · Drop D (D A D G B E)", notes: [38, 45, 50, 55, 59, 64] },
    { id: "dadgad", name: "Guitar · DADGAD", notes: [38, 45, 50, 55, 57, 62] },
    { id: "openg", name: "Guitar · Open G (D G D G B D)", notes: [38, 43, 50, 55, 59, 62] },
    { id: "opend", name: "Guitar · Open D (D A D F♯ A D)", notes: [38, 45, 50, 54, 57, 62] },
    { id: "half", name: "Guitar · Half step down (E♭)", notes: [39, 44, 49, 54, 58, 63] },
    { id: "bass4", name: "Bass · 4-string (E A D G)", notes: [28, 33, 38, 43] },
    { id: "bass5", name: "Bass · 5-string (B E A D G)", notes: [23, 28, 33, 38, 43] },
    { id: "bassdd", name: "Bass · Drop D (D A D G)", notes: [26, 33, 38, 43] },
    { id: "uke", name: "Ukulele · Standard (G C E A)", notes: [67, 60, 64, 69] },
    { id: "chrom", name: "Chromatic · any note", notes: [] }
  ];

  // ---------- pure logic (tested in S3_SELFTEST) ----------
  function midiToFreq(m, a4) { return a4 * Math.pow(2, (m - 69) / 12); }
  function noteName(m) { return NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1); }
  function noteInfo(f, a4) {
    var midi = 69 + 12 * Math.log2(f / a4), n = Math.round(midi);
    return { midi: n, name: NAMES[((n % 12) + 12) % 12], octave: Math.floor(n / 12) - 1, cents: (midi - n) * 100 };
  }
  function centsBetween(f, ref) { return 1200 * Math.log2(f / ref); }
  function closestString(f, notes, a4) {
    var best = -1, bd = Infinity;
    notes.forEach(function (m, i) { var d = Math.abs(centsBetween(f, midiToFreq(m, a4))); if (d < bd) { bd = d; best = i; } });
    return best;
  }
  // Analysis window long enough for two periods of the lowest note we care about.
  function windowFor(rate, minF) { var n = 2048; while (n < 2.2 * rate / minF && n < 32768) n *= 2; return n; }
  // YIN (de Cheveigné & Kawahara 2002): cumulative-mean-normalised difference + parabolic interpolation.
  function yin(x, rate, minF, maxF, threshold) {
    threshold = threshold || 0.12;
    var maxTau = Math.min(Math.floor(rate / minF), Math.floor(x.length / 2)), minTau = Math.max(2, Math.floor(rate / maxF));
    var W = x.length - maxTau, e = 0, i;
    for (i = 0; i < x.length; i++) e += x[i] * x[i];
    if (Math.sqrt(e / x.length) < 0.008) return null; // silence
    var d = new Float32Array(maxTau + 1), run = 0, tau;
    d[0] = 1;
    for (tau = 1; tau <= maxTau; tau++) {
      var s = 0;
      for (i = 0; i < W; i++) { var df = x[i] - x[i + tau]; s += df * df; }
      run += s;
      d[tau] = run ? s * tau / run : 1;
    }
    var best = -1;
    for (tau = minTau; tau <= maxTau; tau++) {
      if (d[tau] < threshold) { while (tau + 1 <= maxTau && d[tau + 1] < d[tau]) tau++; best = tau; break; }
    }
    if (best < 0) { // no dip under the threshold: accept the global minimum only if it is clearly periodic
      var m = Infinity; for (tau = minTau; tau <= maxTau; tau++) if (d[tau] < m) { m = d[tau]; best = tau; }
      if (m > 0.35) return null;
    }
    var t = best;
    if (best > 1 && best < maxTau) {
      var a = d[best - 1], b = d[best], c = d[best + 1], den = a - 2 * b + c;
      if (den) t = best + (a - c) / (2 * den);
    }
    return { freq: rate / t, clarity: 1 - d[best] };
  }
  function median(a) { var s = a.slice().sort(function (p, q) { return p - q; }); return s[s.length >> 1]; }

  // ---------- state ----------
  var S = Object.assign({ tuning: "std", a4: 440, sustain: false }, S3.store("tuner") || {});
  var tuning = TUNINGS.filter(function (t) { return t.id === S.tuning; })[0] || TUNINGS[0];
  var ctx = null, mic = null, target = -1, auto = true, recent = [], ref = null, lastSeen = 0, frame = 0;

  // ---------- gauge ----------
  (function ticks() {
    var g = $("#ticks"), ns = "http://www.w3.org/2000/svg";
    for (var c = -50; c <= 50; c += 5) {
      var a = c * 1.2 * Math.PI / 180, major = c % 25 === 0, r1 = 130, r2 = major ? 116 : 122;
      var l = document.createElementNS(ns, "line");
      l.setAttribute("x1", 150 + r1 * Math.sin(a)); l.setAttribute("y1", 160 - r1 * Math.cos(a));
      l.setAttribute("x2", 150 + r2 * Math.sin(a)); l.setAttribute("y2", 160 - r2 * Math.cos(a));
      l.setAttribute("class", "tick" + (major ? " major" : "")); g.appendChild(l);
      if (major) {
        var t = document.createElementNS(ns, "text");
        t.setAttribute("x", 150 + 145 * Math.sin(a)); t.setAttribute("y", 164 - 145 * Math.cos(a));
        t.setAttribute("class", "lbl"); t.textContent = c > 0 ? "+" + c : c; g.appendChild(t);
      }
    }
  })();

  function show(freq) {
    var main = $(".gt-main");
    if (!freq) {
      main.classList.add("idle"); main.classList.remove("in-tune");
      return;
    }
    var info = noteInfo(freq, S.a4), cents = info.cents, label = info.name, oct = info.octave, idx = -1;
    if (tuning.notes.length) {
      idx = auto ? closestString(freq, tuning.notes, S.a4) : target;
      var m = tuning.notes[idx];
      cents = centsBetween(freq, midiToFreq(m, S.a4));
      label = NAMES[m % 12]; oct = Math.floor(m / 12) - 1;
      if (auto) setTarget(idx, true);
    }
    main.classList.remove("idle");
    var inTune = Math.abs(cents) < 5;
    main.classList.toggle("in-tune", inTune);
    var note = $("#note"); note.textContent = label; note.appendChild(S3.h("sub", { text: String(oct) }));
    $("#cents").textContent = (cents >= 0 ? "+" : "−") + Math.abs(cents).toFixed(1) + " cents" + (tuning.notes.length && Math.abs(cents) > 60 ? " · you're playing " + info.name + info.octave : "");
    $("#hz").textContent = freq.toFixed(2) + " Hz";
    $("#needle").style.transform = "rotate(" + (Math.max(-50, Math.min(50, cents)) * 1.2).toFixed(2) + "deg)";
    $("#advice").textContent = inTune ? "In tune ✓" : cents < 0 ? "Too low · tune up ↑" : "Too high · tune down ↓";
    if (inTune && idx >= 0) $$(".str")[idx].classList.add("done");
  }
  function setTarget(i, fromAuto) {
    target = i;
    $$(".str").forEach(function (b, k) { b.classList.toggle("target", k === i); b.setAttribute("aria-pressed", String(k === i && !fromAuto)); });
  }
  function renderStrings() {
    var box = $("#strings"); box.innerHTML = "";
    tuning.notes.forEach(function (m, i) {
      var b = S3.h("button", { "class": "str", title: "Play " + noteName(m) + " (" + midiToFreq(m, S.a4).toFixed(2) + " Hz)" }, [NAMES[m % 12], S3.h("small", { text: String(Math.floor(m / 12) - 1) })]);
      b.addEventListener("click", function () { auto = false; $("#auto").setAttribute("aria-pressed", "false"); setTarget(i, false); playRef(m, b); });
      box.appendChild(b);
    });
    $("#auto").hidden = !tuning.notes.length;
    target = -1;
  }

  // ---------- reference tone ----------
  async function ensureCtx() { if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)(); await ctx.resume(); }
  function stopRef() { if (ref) { var r = ref; ref = null; r.g.gain.cancelScheduledValues(ctx.currentTime); r.g.gain.setTargetAtTime(0, ctx.currentTime, 0.03); r.oscs.forEach(function (o) { o.stop(ctx.currentTime + 0.2); }); r.btn.classList.remove("ringing"); } }
  async function playRef(m, btn) {
    await ensureCtx();
    var same = ref && ref.btn === btn; stopRef();
    if (same && S.sustain) return;
    var f = midiToFreq(m, S.a4), t = ctx.currentTime, g = ctx.createGain(), oscs = [];
    [[1, 0.6], [2, 0.25], [3, 0.12], [4, 0.06]].forEach(function (h) {
      var o = ctx.createOscillator(), og = ctx.createGain(); o.frequency.value = f * h[0]; og.gain.value = h[1];
      o.connect(og); og.connect(g); o.start(t); oscs.push(o);
    });
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.35, t + 0.01);
    if (!S.sustain) { g.gain.exponentialRampToValueAtTime(0.0001, t + 2.6); oscs.forEach(function (o) { o.stop(t + 2.7); }); }
    g.connect(ctx.destination);
    ref = { g: g, oscs: oscs, btn: btn }; btn.classList.add("ringing");
    var mine = ref; if (!S.sustain) setTimeout(function () { if (ref === mine) { btn.classList.remove("ringing"); ref = null; } }, 2600);
  }

  // ---------- microphone ----------
  function notice(t) { $("#notice").hidden = !t; $("#notice").textContent = t || ""; }
  function setStatus(t, k) { $("#status").textContent = t; $("#status").className = "chip" + (k ? " " + k : ""); }
  function lowestF() { return tuning.notes.length ? midiToFreq(Math.min.apply(null, tuning.notes), S.a4) * 0.75 : 27; }
  function highestF() { return tuning.notes.length ? midiToFreq(Math.max.apply(null, tuning.notes), S.a4) * 1.5 : 2000; }
  function configureAnalyser() { if (mic) { mic.an.fftSize = windowFor(ctx.sampleRate, lowestF()); mic.buf = new Float32Array(mic.an.fftSize); } }
  async function startMic() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { notice(window.isSecureContext === false ? "The microphone needs a secure page (https or localhost)." : "This browser can't use the microphone."); return; }
    notice(""); setStatus("Asking for the microphone…");
    var stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } }); }
    catch (e) {
      setStatus("Microphone off", "bad");
      notice(e && e.name === "NotAllowedError" ? "Microphone access was blocked. Allow it from the address bar (lock or mic icon), then press Start tuning again. You can still use the reference tones."
        : e && e.name === "NotFoundError" ? "No microphone was found." : "Couldn't open the microphone: " + (e && e.message || e));
      return;
    }
    await ensureCtx();
    var src = ctx.createMediaStreamSource(stream), an = ctx.createAnalyser();
    src.connect(an);
    mic = { stream: stream, src: src, an: an };
    configureAnalyser();
    setStatus("● Listening", "ok");
    $("#mic span").textContent = "Stop"; $("#mic use").setAttribute("href", "#i-pause");
    loop();
    S3.done();
  }
  function stopMic() {
    if (!mic) return;
    mic.stream.getTracks().forEach(function (t) { t.stop(); }); mic.src.disconnect(); mic = null;
    setStatus("Microphone off"); $("#mic span").textContent = "Start tuning"; $("#mic use").setAttribute("href", "#i-play");
    show(null); $("#advice").innerHTML = "&nbsp;";
  }
  function loop() {
    if (!mic) return;
    requestAnimationFrame(loop);
    if (frame++ % 2) return; // ~30 analyses a second is plenty
    mic.an.getFloatTimeDomainData(mic.buf);
    var r = yin(mic.buf, ctx.sampleRate, lowestF(), highestF());
    var now = performance.now();
    if (r && r.clarity > 0.8) {
      recent.push(r.freq); if (recent.length > 5) recent.shift();
      lastSeen = now; show(median(recent));
    } else if (now - lastSeen > 900) { recent = []; show(null); $("#advice").textContent = "Play a string"; }
  }
  $("#mic").addEventListener("click", function () { if (mic) stopMic(); else startMic(); });
  $("#auto").addEventListener("click", function () { auto = true; this.setAttribute("aria-pressed", "true"); setTarget(-1, true); });

  // ---------- settings ----------
  TUNINGS.forEach(function (t) { $("#tuning").appendChild(S3.h("option", { value: t.id, text: t.name })); });
  $("#tuning").value = tuning.id;
  $("#tuning").addEventListener("change", function () {
    tuning = TUNINGS.filter(function (t) { return t.id === $("#tuning").value; })[0];
    S.tuning = tuning.id; S3.store("tuner", S); stopRef(); renderStrings(); configureAnalyser(); recent = [];
  });
  $("#a4").value = S.a4; $("#a4v").textContent = S.a4 + " Hz";
  $("#a4").addEventListener("input", function () { S.a4 = +this.value; $("#a4v").textContent = S.a4 + " Hz"; S3.store("tuner", S); renderStrings(); });
  $("#sustain").checked = S.sustain;
  $("#sustain").addEventListener("change", function () { S.sustain = this.checked; S3.store("tuner", S); stopRef(); });
  renderStrings(); show(null);

  // ---------- demo + self-test ----------
  function synth(f, rate, n, harm) {
    var x = new Float32Array(n);
    for (var i = 0; i < n; i++) { var t = i / rate, s = 0; for (var h = 1; h <= harm; h++) s += Math.sin(2 * Math.PI * f * h * t + h) / h; x[i] = 0.4 * s; }
    return x;
  }
  window.S3_DEMO = function () { show(111.2); setStatus("● Listening", "ok"); $("#mic span").textContent = "Stop"; $("#mic use").setAttribute("href", "#i-pause"); $$(".str")[0].classList.add("done"); };

  window.S3_SELFTEST = function () {
    function tunes(f, rate, minF, expect, a4) {
      var r = yin(synth(f, rate, windowFor(rate, minF), 6), rate, minF, 2000);
      if (!r) return false;
      var info = noteInfo(r.freq, a4 || 440);
      return info.name + info.octave === expect && Math.abs(centsBetween(r.freq, f)) < 2;
    }
    var ok = tunes(440, 48000, 61.8, "A4") && tunes(82.41, 44100, 61.8, "E2") && tunes(82.41, 48000, 61.8, "E2") &&
      tunes(30.87, 48000, 23.1, "B0") && tunes(329.63, 44100, 61.8, "E4") && tunes(392, 96000, 300, "G4");
    // slightly flat low E is reported flat by the right amount
    var flat = yin(synth(82.41 * Math.pow(2, -12 / 1200), 44100, windowFor(44100, 61.8), 6), 44100, 61.8, 2000);
    ok = ok && flat && Math.abs(centsBetween(flat.freq, 82.4069) + 12) < 2;
    ok = ok && yin(new Float32Array(4096), 48000, 60, 2000) === null; // silence
    var n = noteInfo(432, 432); ok = ok && n.name === "A" && n.octave === 4 && Math.abs(n.cents) < 1e-9;
    n = noteInfo(445, 440); ok = ok && n.name === "A" && Math.abs(n.cents - 19.56) < 0.01;
    ok = ok && Math.abs(midiToFreq(40, 440) - 82.4069) < 1e-3 && noteName(40) === "E2" && noteName(69) === "A4" && noteName(23) === "B0";
    ok = ok && closestString(146, TUNINGS[0].notes, 440) === 2 && closestString(85, TUNINGS[0].notes, 440) === 0;
    ok = ok && windowFor(48000, 61.8) === 2048 && windowFor(48000, 23.1) === 8192 && median([5, 1, 3]) === 3;
    return ok;
  };
})();
