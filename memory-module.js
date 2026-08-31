/* Memory — module autonome pour le serveur combine (Loup-Garou + Imposteur).
   Ce fichier ne depend de rien d'autre : il porte ses propres sessions,
   ses propres fonctions json/lireCorps, sur le meme modele que le bloc
   IMPOSTEUR de server.js. Integration en 2 lignes dans server.js
   (voir README-integration.md).

   Routes exposees (a brancher sur prefixe "/memory/api/") :
     POST /memory/api/session                     { nom }
     POST /memory/api/session/:code/join           { nom }
     POST /memory/api/session/:code/start          { joueurId }
     POST /memory/api/session/:code/flip           { joueurId, index }
     POST /memory/api/session/:code/rejouer        { joueurId }
     GET  /memory/api/session/:code/stream?joueurId=&token=
*/

const crypto = require("crypto");

const MIN_JOUEURS = 2;
const MAX_JOUEURS = 8;

// 30 symboles distincts -> jusqu'a 60 tuiles (30 paires) au maximum.
const SYMBOLES = [
  "🍎","🍌","🍇","🍉","🍒","🍕","🍔","🍟","🌮","🍩",
  "⚽","🏀","🎸","🎧","🚗","✈️","🌟","🌈","🐶","🐱",
  "🦁","🐸","🐢","🦋","🐙","🦄","🍦","🎁","🎈","🌻"
];
const MIN_TUILES = 4;
const MAX_TUILES = SYMBOLES.length * 2;
const DEFAUT_TUILES = 40;

const sessions = new Map(); // code -> session
const ALPHA = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // sans I, L, O, 0, 1

function code4() {
  let c;
  do {
    c = "";
    for (let i = 0; i < 4; i++) c += ALPHA[crypto.randomInt(ALPHA.length)];
  } while (sessions.has(c));
  return c;
}
function idJoueur() { return crypto.randomBytes(6).toString("hex"); }
function jeton() { return crypto.randomBytes(16).toString("hex"); }

function lireCorps(req) {
  return new Promise((resolve) => {
    let d = "";
    req.on("data", (c) => { d += c; if (d.length > 1e6) req.destroy(); });
    req.on("end", () => { try { resolve(JSON.parse(d || "{}")); } catch (e) { resolve({}); } });
  });
}
function json(res, obj, statut) {
  res.writeHead(statut || 200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}
function ecrire(res, obj) { try { res.write("data: " + JSON.stringify(obj) + "\n\n"); } catch (e) {} }

/* ---------- plateau ---------- */
function melanger(tab) {
  for (let i = tab.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    const tmp = tab[i]; tab[i] = tab[j]; tab[j] = tmp;
  }
  return tab;
}
function nouveauPlateau(nbTuiles) {
  const nbPaires = nbTuiles / 2;
  const choix = melanger(SYMBOLES.slice()).slice(0, nbPaires);
  const cartes = [];
  choix.forEach((s, i) => {
    cartes.push({ pairId: i, symbole: s });
    cartes.push({ pairId: i, symbole: s });
  });
  return melanger(cartes);
}

/* ---------- vue envoyee aux clients ---------- */
function vue(s) {
  const joueurs = s.order.map((id) => {
    const j = s.players.get(id);
    return { id, nom: j.nom, connecte: j.clients.size > 0, score: s.scores[id] || 0 };
  });
  return {
    type: "etat",
    phase: s.phase,
    code: s.code,
    hostId: s.hostId,
    joueurs,
    tourDe: s.order[s.turnIndex] || null,
    // deux tuiles non appariees affichees : elles restent visibles tant que
    // le joueur suivant n'a pas clique sur sa propre premiere tuile.
    enAttente: !!s.enAttente,
    nbTuiles: s.nbTuiles || DEFAUT_TUILES,
    plateau: s.phase === "lobby"
      ? []
      : s.board.map((c, i) => {
          const visible = s.matched.has(i) || s.flipped.includes(i);
          return { index: i, visible, symbole: visible ? c.symbole : null, trouvee: s.matched.has(i) };
        }),
    gagnants: s.phase === "finished" ? calculerGagnants(s) : null
  };
}
function calculerGagnants(s) {
  let max = -1;
  s.order.forEach((id) => { if ((s.scores[id] || 0) > max) max = s.scores[id] || 0; });
  return s.order.filter((id) => (s.scores[id] || 0) === max);
}
function diffuser(s) {
  s.maj = Date.now();
  const v = vue(s);
  s.players.forEach((j) => { j.clients.forEach((r) => ecrire(r, v)); });
}

/* ---------- API ---------- */
async function api(req, res, url, sub) {
  // sub = segments apres "memory", ex: ["api","session"] ou ["api","session","ABCD","join"]

  // POST /memory/api/session  { nom, nbTuiles? }
  if (req.method === "POST" && sub[0] === "api" && sub[1] === "session" && sub.length === 2) {
    const b = await lireCorps(req);
    const nom = String(b.nom || "").trim().slice(0, 20);
    if (!nom) return json(res, { ok: false, erreur: "Nom requis" }, 400);
    let nbTuiles = parseInt(b.nbTuiles, 10);
    if (!Number.isFinite(nbTuiles)) nbTuiles = DEFAUT_TUILES;
    if (nbTuiles % 2 !== 0) nbTuiles -= 1;
    nbTuiles = Math.max(MIN_TUILES, Math.min(MAX_TUILES, nbTuiles));

    const code = code4();
    const id = idJoueur();
    const tok = jeton();
    const s = {
      code, hostId: id,
      players: new Map(),
      order: [],
      turnIndex: 0,
      phase: "lobby",
      board: [],
      flipped: [],
      matched: new Set(),
      scores: {},
      enAttente: false,
      nbTuiles,
      maj: Date.now()
    };
    s.players.set(id, { id, nom, token: tok, clients: new Set() });
    s.order.push(id);
    s.scores[id] = 0;
    sessions.set(code, s);
    return json(res, { ok: true, code, joueurId: id, token: tok });
  }

  const code = (sub[2] || "").toUpperCase();
  const s = sessions.get(code);

  // GET /memory/api/session/:code/stream?joueurId=&token=
  if (req.method === "GET" && sub[0] === "api" && sub[1] === "session" && sub[3] === "stream") {
    if (!s) return json(res, { ok: false, erreur: "Session introuvable" }, 404);
    const joueurId = url.searchParams.get("joueurId");
    const token = url.searchParams.get("token");
    const j = s.players.get(joueurId);
    if (!j || j.token !== token) return json(res, { ok: false, erreur: "Non autorise" }, 403);

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
    res.write(": bienvenue\n\n");
    j.clients.add(res);
    ecrire(res, vue(s));
    diffuser(s);

    const battement = setInterval(() => { try { res.write(": ping\n\n"); } catch (e) {} }, 25000);
    req.on("close", () => {
      clearInterval(battement);
      j.clients.delete(res);
      diffuser(s);
    });
    return;
  }

  // POST /memory/api/session/:code/join { nom }
  if (req.method === "POST" && sub[0] === "api" && sub[1] === "session" && sub[3] === "join") {
    if (!s) return json(res, { ok: false, erreur: "Session introuvable" }, 404);
    if (s.phase !== "lobby") return json(res, { ok: false, erreur: "La partie a deja commence" }, 409);
    if (s.order.length >= MAX_JOUEURS) return json(res, { ok: false, erreur: "Partie complete" }, 409);
    const b = await lireCorps(req);
    const nom = String(b.nom || "").trim().slice(0, 20);
    if (!nom) return json(res, { ok: false, erreur: "Nom requis" }, 400);
    const id = idJoueur();
    const tok = jeton();
    s.players.set(id, { id, nom, token: tok, clients: new Set() });
    s.order.push(id);
    s.scores[id] = 0;
    diffuser(s);
    return json(res, { ok: true, code, joueurId: id, token: tok });
  }

  // POST /memory/api/session/:code/start { joueurId }
  if (req.method === "POST" && sub[0] === "api" && sub[1] === "session" && sub[3] === "start") {
    if (!s) return json(res, { ok: false, erreur: "Session introuvable" }, 404);
    const b = await lireCorps(req);
    if (b.joueurId !== s.hostId) return json(res, { ok: false, erreur: "Reserve a l'hote" }, 403);
    if (s.order.length < MIN_JOUEURS) return json(res, { ok: false, erreur: "Au moins deux joueurs" }, 400);
    s.board = nouveauPlateau(s.nbTuiles);
    s.flipped = [];
    s.matched = new Set();
    s.turnIndex = 0;
    s.enAttente = false;
    s.order.forEach((id2) => { s.scores[id2] = 0; });
    s.phase = "playing";
    diffuser(s);
    return json(res, { ok: true });
  }

  // POST /memory/api/session/:code/flip { joueurId, index }
  if (req.method === "POST" && sub[0] === "api" && sub[1] === "session" && sub[3] === "flip") {
    if (!s) return json(res, { ok: false, erreur: "Session introuvable" }, 404);
    if (s.phase !== "playing") return json(res, { ok: false, erreur: "Partie non demarree" }, 409);
    const b = await lireCorps(req);
    const index = Number(b.index);
    if (s.order[s.turnIndex] !== b.joueurId) return json(res, { ok: false, erreur: "Pas votre tour" }, 403);
    if (!Number.isInteger(index) || index < 0 || index >= s.board.length) return json(res, { ok: false, erreur: "Index invalide" }, 400);

    // une paire non appariee est encore affichee : ce clic la referme d'abord,
    // puis ce meme clic devient la premiere tuile du nouveau tour.
    if (s.enAttente) {
      s.flipped = [];
      s.enAttente = false;
    }

    if (s.matched.has(index) || s.flipped.includes(index)) return json(res, { ok: false, erreur: "Carte deja retournee" }, 400);
    if (s.flipped.length >= 2) return json(res, { ok: false, erreur: "Deux cartes deja retournees" }, 409);

    s.flipped.push(index);

    if (s.flipped.length < 2) {
      diffuser(s);
      return json(res, { ok: true });
    }

    const i1 = s.flipped[0], i2 = s.flipped[1];
    const paire = s.board[i1].pairId === s.board[i2].pairId;

    if (paire) {
      s.matched.add(i1); s.matched.add(i2);
      s.scores[b.joueurId] = (s.scores[b.joueurId] || 0) + 1;
      s.flipped = [];
      if (s.matched.size === s.board.length) s.phase = "finished";
      diffuser(s);
      return json(res, { ok: true });
    }

    // pas de paire : reste affichee, la main passe, le retournement effectif
    // n'aura lieu qu'au prochain clic (voir plus haut).
    s.enAttente = true;
    s.turnIndex = (s.turnIndex + 1) % s.order.length;
    diffuser(s);
    return json(res, { ok: true });
  }

  // POST /memory/api/session/:code/rejouer { joueurId }
  if (req.method === "POST" && sub[0] === "api" && sub[1] === "session" && sub[3] === "rejouer") {
    if (!s) return json(res, { ok: false, erreur: "Session introuvable" }, 404);
    const b = await lireCorps(req);
    if (b.joueurId !== s.hostId) return json(res, { ok: false, erreur: "Reserve a l'hote" }, 403);
    s.phase = "lobby";
    s.board = []; s.flipped = []; s.matched = new Set(); s.turnIndex = 0; s.enAttente = false;
    s.order.forEach((id2) => { s.scores[id2] = 0; });
    diffuser(s);
    return json(res, { ok: true });
  }

  return json(res, { ok: false, erreur: "Route inconnue" }, 404);
}

// pas de nettoyage interne : la Map `sessions` est exportee et purgee par
// le setInterval central de server.js, comme pour les deux autres jeux.
module.exports = { api, sessions };
