/* Deux jeux, un seul service
   ------------------------------------------------------------------
   Le Loup-Garou de Thiercelieux  ->  /loup-garou/
   Imposteur — Dossier confidentiel ->  /imposteur/

   Node pur, aucune dependance.  `node server.js`  puis http://localhost:3000
   Les deux jeux gardent des sessions totalement separees :
     - Loup-Garou : routes /api/*  et  /sse
     - Imposteur  : routes /imposteur/api/*
*/

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const PUB = path.join(__dirname, "public");
const MIME = {".html":"text/html; charset=utf-8", ".js":"application/javascript; charset=utf-8",
  ".css":"text/css; charset=utf-8", ".json":"application/json", ".svg":"image/svg+xml",
  ".png":"image/png", ".ico":"image/x-icon", ".webmanifest":"application/manifest+json"};

/* ==================================================================
   LOUP-GAROU
   ================================================================== */
const parties = new Map();
const ALPHA = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";     // sans I, L, O, 0, 1
const jeton = () => crypto.randomBytes(12).toString("hex");
function code4(){
  let c;
  do { c = ""; for(let i=0;i<4;i++) c += ALPHA[crypto.randomInt(ALPHA.length)]; }
  while(parties.has(c));
  return c;
}
function lireCorps(req){
  return new Promise(function(res){
    let d = "";
    req.on("data", function(c){ d += c; if(d.length > 1e6) req.destroy(); });
    req.on("end", function(){ try{ res(JSON.parse(d || "{}")); }catch(e){ res({}); } });
  });
}
function json(res, o, st){
  res.writeHead(st || 200, {"Content-Type":"application/json; charset=utf-8", "Cache-Control":"no-store"});
  res.end(JSON.stringify(o));
}
function ecrire(res, o){ try{ res.write("data: " + JSON.stringify(o) + "\n\n"); }catch(e){} }

/* ---------- diffusion ---------- */
function vueMJ(p){
  return {
    type:"etat",
    joueurs: p.joueurs.map(function(j){ return {id:j.id, nom:j.nom, connecte:j.flux.length>0}; })
  };
}
function vueJoueur(p, j){
  return {
    type:"etat",
    moi: {id:j.id, nom:j.nom},
    public: p.pub,
    prive: p.prive[j.id] || null
  };
}
function diffuserJoueurs(p){
  p.maj = Date.now();
  p.joueurs.forEach(function(j){ j.flux.forEach(function(r){ ecrire(r, vueJoueur(p, j)); }); });
}
function diffuser(p){
  p.maj = Date.now();
  p.mjFlux.forEach(function(r){ ecrire(r, vueMJ(p)); });
  diffuserJoueurs(p);
}

/* ---------- API ---------- */
async function lgApi(req, res, url){
  const route = url.pathname;
  const b = (req.method === "POST") ? await lireCorps(req) : {};
  const p = b.code ? parties.get(String(b.code).toUpperCase()) : null;
  const estMJ = p && b.mjToken && b.mjToken === p.mjToken;

  if(route === "/api/creer"){
    /* un code + un jeton fournis = le meneur restaure une session perdue (redémarrage serveur) */
    const reprise = b.code && b.mjToken && !parties.has(String(b.code).toUpperCase());
    const c = reprise ? String(b.code).toUpperCase() : code4();
    parties.set(c, {code:c, mjToken: reprise ? b.mjToken : jeton(), mjFlux:[], joueurs:[], pub:{}, prive:{},
      demarree:false, maj:Date.now()});
    return json(res, {ok:true, code:c, mjToken: parties.get(c).mjToken, restauree: !!reprise});
  }

  if(route === "/api/reprendre"){                       // le meneur revient (onglet fermé, F5…)
    if(!p || !estMJ) return json(res, {ok:false, erreur:"session introuvable"}, 404);
    return json(res, {ok:true, code:p.code, demarree:p.demarree,
      joueurs:p.joueurs.map(function(j){ return {id:j.id, nom:j.nom, connecte:j.flux.length>0}; })});
  }

  if(route === "/api/rejoindre"){
    if(!p) return json(res, {ok:false, erreur:"Aucune partie avec ce code."}, 404);
    const nom = String(b.nom || "").trim().slice(0, 24);
    if(!nom) return json(res, {ok:false, erreur:"Il faut un prénom."}, 400);
    if(p.demarree) return json(res, {ok:false, erreur:"La partie a déjà commencé."}, 403);
    if(p.joueurs.length >= 40) return json(res, {ok:false, erreur:"Village complet."}, 403);
    if(p.joueurs.some(function(j){ return j.nom.toLowerCase() === nom.toLowerCase(); }))
      return json(res, {ok:false, erreur:"Ce prénom est déjà pris."}, 409);
    const j = {id:"j" + jeton().slice(0,6), nom:nom, token:jeton(), flux:[]};
    p.joueurs.push(j);
    diffuser(p);
    return json(res, {ok:true, id:j.id, token:j.token, nom:j.nom});
  }

  if(route === "/api/reprendre-joueur"){
    if(!p) return json(res, {ok:false, erreur:"session introuvable"}, 404);
    let j = p.joueurs.find(function(x){ return x.token === b.token; });
    if(!j && b.id && b.nom && !p.joueurs.some(function(x){ return x.id === b.id; })){
      j = {id:String(b.id), nom:String(b.nom).slice(0,24), token:String(b.token), flux:[]};
      p.joueurs.push(j);                       /* le serveur a redémarré : on reconstitue sa place */
      diffuser(p);
    }
    if(!j) return json(res, {ok:false, erreur:"place introuvable"}, 404);
    return json(res, {ok:true, id:j.id, nom:j.nom});
  }

  if(route === "/api/pousser"){                          // le meneur publie l'état
    if(!p || !estMJ) return json(res, {ok:false}, 403);
    if(b.public) p.pub = b.public;
    if(b.prive) p.prive = b.prive;
    p.demarree = !!b.demarree;
    diffuserJoueurs(p);            /* jamais vers le meneur : évite la boucle rendu → push → rendu */
    return json(res, {ok:true});
  }

  if(route === "/api/retirer"){
    if(!p || !estMJ) return json(res, {ok:false}, 403);
    const i = p.joueurs.findIndex(function(x){ return x.id === b.id; });
    if(i >= 0){ p.joueurs[i].flux.forEach(function(r){ try{ r.end(); }catch(e){} }); p.joueurs.splice(i,1); }
    diffuser(p);
    return json(res, {ok:true});
  }

  return json(res, {ok:false, erreur:"route inconnue"}, 404);
}

/* ---------- flux SSE ---------- */
function lgFlux(req, res, url){
  const p = parties.get(String(url.searchParams.get("code") || "").toUpperCase());
  const token = url.searchParams.get("token");
  const role = url.searchParams.get("role");
  if(!p) return json(res, {ok:false, erreur:"session introuvable"}, 404);

  res.writeHead(200, {"Content-Type":"text/event-stream; charset=utf-8",
    "Cache-Control":"no-cache, no-transform", "Connection":"keep-alive", "X-Accel-Buffering":"no"});
  res.write(": bienvenue\n\n");

  let cible = null;
  if(role === "mj"){
    if(token !== p.mjToken){ res.end(); return; }
    p.mjFlux.push(res);
    ecrire(res, vueMJ(p));
  } else {
    cible = p.joueurs.find(function(x){ return x.token === token; });
    if(!cible){ ecrire(res, {type:"inconnu"}); res.end(); return; }
    cible.flux.push(res);
    ecrire(res, vueJoueur(p, cible));
    diffuser(p);                                   // signale au meneur qu'il est connecté
  }
  const battement = setInterval(function(){ try{ res.write(": ping\n\n"); }catch(e){} }, 25000);
  req.on("close", function(){
    clearInterval(battement);
    if(role === "mj") p.mjFlux = p.mjFlux.filter(function(r){ return r !== res; });
    else if(cible){ cible.flux = cible.flux.filter(function(r){ return r !== res; }); diffuser(p); }
  });
}

/* ==================================================================
   IMPOSTEUR
   ================================================================== */
const CATEGORIES = {
  divers: {
    label: "Au hasard",
    pairs: [
      ["Pirate","Cow-boy"],
      ["Vampire","Loup-garou"],
      ["Sorcière","Extraterrestre"],
      ["Chevalier","Gladiateur"],
      ["Ninja","Samouraï"],
      ["Docteur","Pompier"],
      ["Facteur","Boulanger"],
      ["Chat","Perroquet"],
      ["Chef cuisinier","Mécanicien"],
      ["Policier","Agent secret"],
      ["Astronaute","Plongeur"],
      ["Fée","Lutin"],
      ["Professeur","Bibliothécaire"],
      ["Robot","Fantôme"],
      ["Squelette","Zombie"],
      ["Surfeur","Alpiniste"],
      ["Boxeur","Danseur"],
      ["Espion","Voleur"],
      ["Roi","Chevalier"],
      ["Loup","Ours"],
      ["Clown","Ventriloque"],
      ["Cow-boy","Chasseur de trésors"],
      ["Café","Chocolat chaud"],
      ["Guitare","Batterie"],
      ["Piscine","Montagne"],
      ["Train","Bateau"],
      ["Pizza","Sushi"],
      ["Lion","Éléphant"],
      ["Aigle","Pingouin"],
      ["Croissant","Gaufre"],
      ["Sapin","Cactus"],
      ["Dauphin","Tortue"],
      ["Papillon","Escargot"],
      ["Pompier","Bibliothécaire"],
      ["Jardinier","Photographe"],
      ["DJ","Magicien"],
      ["Chanteur","Peintre"],
      ["Alpiniste","Explorateur polaire"],
      ["Mécanicien","Pilote de course"],
      ["Champignon","Cactus"]
    ]
  },
  mangas: {
    label: "Mangas",
    pairs: [
      ["Naruto Uzumaki","Sasuke Uchiha"],
      ["Naruto Uzumaki","Monkey D. Luffy"],
      ["Naruto Uzumaki","Tanjiro Kamado"],
      ["Sasuke Uchiha","Levi Ackerman"],
      ["Sakura Haruno","Mikasa Ackerman"],
      ["Kakashi Hatake","Erwin Smith"],
      ["Itachi Uchiha","Reiner Braun"],
      ["Jiraiya","Kyojuro Rengoku"],
      ["Gaara","Sukuna"],
      ["Rock Lee","Toge Inumaki"],
      ["Shikamaru Nara","Armin Arlert"],
      ["Hinata Hyuga","Historia Reiss"],
      ["Madara Uchiha","Zeke Yeager"],
      ["Obito Uchiha","Muzan Kibutsuji"],
      ["Son Goku","Vegeta"],
      ["Son Goku","Monkey D. Luffy"],
      ["Son Goku","Yuji Itadori"],
      ["Piccolo","Giyu Tomioka"],
      ["Gohan","Yuta Okkotsu"],
      ["Trunks","Megumi Fushiguro"],
      ["Frieza","Muzan Kibutsuji"],
      ["Cell","Akaza"],
      ["Bulma","Nico Robin"],
      ["Krillin","Usopp"],
      ["Light Yagami","L"],
      ["Light Yagami","Sasuke Uchiha"],
      ["L","Near"],
      ["Misa Amane","Nezuko Kamado"],
      ["Ryuk","Zeke Yeager"],
      ["Monkey D. Luffy","Yuji Itadori"],
      ["Roronoa Zoro","Maki Zenin"],
      ["Nami","Nobara Kugisaki"],
      ["Sanji","Nanami Kento"],
      ["Tony Tony Chopper","Zenitsu Agatsuma"],
      ["Trafalgar Law","Kakashi Hatake"],
      ["Boa Hancock","Shinobu Kocho"],
      ["Satoru Gojo","Whis"],
      ["Sukuna","Frieza"],
      ["Inosuke Hashibira","Vegeta"],
      ["Akaza","Orochimaru"]
    ]
  },
  acteurs: {
    label: "Acteurs de cinéma",
    pairs: [
      ["Chris Evans","Chris Pine"],
      ["Chris Hemsworth","Chris Pratt"],
      ["Chris Evans","Chris Hemsworth"],
      ["Ryan Gosling","Ryan Reynolds"],
      ["Emma Stone","Emma Watson"],
      ["Dwayne Johnson","Vin Diesel"],
      ["Zendaya","Tom Holland"],
      ["Will Smith","Denzel Washington"],
      ["Jennifer Lawrence","Emma Stone"],
      ["Christian Bale","Robert Pattinson"],
      ["Robert Pattinson","Kristen Stewart"],
      ["Ryan Reynolds","Hugh Jackman"],
      ["Chris Hemsworth","Liam Hemsworth"],
      ["Owen Wilson","Luke Wilson"],
      ["Ben Affleck","Casey Affleck"],
      ["Joaquin Phoenix","River Phoenix"],
      ["Dakota Fanning","Elle Fanning"],
      ["Jake Gyllenhaal","Maggie Gyllenhaal"],
      ["Will Smith","Jaden Smith"],
      ["Kate Hudson","Oliver Hudson"],
      ["Tobey Maguire","Andrew Garfield"],
      ["Andrew Garfield","Tom Holland"],
      ["Christian Bale","Michael Keaton"],
      ["Michael Keaton","Ben Affleck"],
      ["Daniel Craig","Pierce Brosnan"],
      ["Sean Connery","Roger Moore"],
      ["Heath Ledger","Joaquin Phoenix"],
      ["Jack Nicholson","Joaquin Phoenix"],
      ["Brad Pitt","Leonardo DiCaprio"],
      ["Robert De Niro","Al Pacino"],
      ["Tom Hanks","Tom Cruise"],
      ["Meryl Streep","Cate Blanchett"],
      ["Denzel Washington","Morgan Freeman"],
      ["Julia Roberts","Sandra Bullock"],
      ["Angelina Jolie","Charlize Theron"],
      ["Natalie Portman","Keira Knightley"],
      ["Scarlett Johansson","Margot Robbie"],
      ["Nicole Kidman","Naomi Watts"],
      ["Daniel Radcliffe","Elijah Wood"],
      ["Timothée Chalamet","Ansel Elgort"]
    ]
  },
  superheros: {
    label: "Super-héros",
    pairs: [
      ["Superman","Shazam"],
      ["Batman","Moon Knight"],
      ["Wolverine","X-23"],
      ["Flash","Quicksilver"],
      ["Hawkeye","Green Arrow"],
      ["Aquaman","Namor"],
      ["Thanos","Darkseid"],
      ["Deadpool","Deathstroke"],
      ["Iron Man","War Machine"],
      ["Wonder Woman","Captain Marvel (Carol Danvers)"],
      ["Doctor Doom","Lex Luthor"],
      ["Joker","Green Goblin"],
      ["Harley Quinn","Poison Ivy"],
      ["Black Widow","Black Cat"],
      ["Professeur X","Magneto"],
      ["Storm","Thor"],
      ["Cyclope","Havok"],
      ["Jean Grey","Scarlet Witch"],
      ["Venom","Carnage"],
      ["Green Lantern","Nova"],
      ["Punisher","Wolverine"],
      ["Robin","Bucky Barnes"],
      ["Black Panther","Namor"],
      ["Nightwing","Daredevil"],
      ["Beast","Colossus"],
      ["Mister Fantastic","Professeur X"],
      ["Silver Surfer","Galactus"],
      ["Ghost Rider","Etrigan"],
      ["Vision","Ultron"],
      ["Cyborg","War Machine"],
      ["Ant-Man","Atom"],
      ["Star-Lord","Nova"],
      ["Gamora","Elektra"],
      ["Groot","Swamp Thing"],
      ["Rocket Raccoon","Beast"],
      ["Martian Manhunter","Vision"],
      ["Kingpin","Bane"],
      ["Colossus","Juggernaut"],
      ["Captain America","Winter Soldier"],
      ["Spider-Man","Miles Morales"]
    ]
  },
  pays: {
    label: "Pays",
    pairs: [
      ["France","Belgique"],
      ["Espagne","Portugal"],
      ["Suède","Norvège"],
      ["Danemark","Pays-Bas"],
      ["Allemagne","Autriche"],
      ["Suisse","Autriche"],
      ["Italie","Espagne"],
      ["Grèce","Chypre"],
      ["Pologne","République tchèque"],
      ["Hongrie","Roumanie"],
      ["Ukraine","Biélorussie"],
      ["Russie","Kazakhstan"],
      ["Finlande","Estonie"],
      ["Irlande","Écosse"],
      ["Royaume-Uni","Irlande"],
      ["Maroc","Algérie"],
      ["Tunisie","Libye"],
      ["Égypte","Soudan"],
      ["Nigeria","Ghana"],
      ["Kenya","Tanzanie"],
      ["Éthiopie","Somalie"],
      ["Afrique du Sud","Namibie"],
      ["Sénégal","Mali"],
      ["Côte d'Ivoire","Ghana"],
      ["Chine","Mongolie"],
      ["Japon","Corée du Sud"],
      ["Corée du Sud","Corée du Nord"],
      ["Inde","Pakistan"],
      ["Bangladesh","Myanmar"],
      ["Thaïlande","Vietnam"],
      ["Vietnam","Laos"],
      ["Cambodge","Laos"],
      ["Indonésie","Malaisie"],
      ["Philippines","Indonésie"],
      ["Australie","Nouvelle-Zélande"],
      ["Canada","États-Unis"],
      ["Mexique","Guatemala"],
      ["Brésil","Argentine"],
      ["Argentine","Uruguay"],
      ["Chili","Pérou"]
    ]
  },
  hasard2: {
    label: "Au hasard 2",
    pairs: [
      ["Marin","Pêcheur"],
      ["Architecte","Ingénieur"],
      ["Avocat","Juge"],
      ["Infirmier","Ambulancier"],
      ["Menuisier","Charpentier"],
      ["Boucher","Poissonnier"],
      ["Coiffeur","Esthéticienne"],
      ["Tatoueur","Sculpteur"],
      ["Randonneur","Cycliste"],
      ["Nageur","Plongeur"],
      ["Escrimeur","Archer"],
      ["Pilote d'hélicoptère","Pilote de chasse"],
      ["Camion","Bus"],
      ["Voilier","Kayak"],
      ["Moto","Scooter"],
      ["Éléphant","Rhinocéros"],
      ["Girafe","Zèbre"],
      ["Ours polaire","Panda"],
      ["Hibou","Chouette"],
      ["Corbeau","Corneille"],
      ["Baleine","Cachalot"],
      ["Méduse","Anémone de mer"],
      ["Cerise","Fraise"],
      ["Citron","Citron vert"],
      ["Riz","Pâtes"],
      ["Fromage","Yaourt"],
      ["Miel","Confiture"],
      ["Volcan","Geyser"],
      ["Désert","Toundra"],
      ["Glacier","Iceberg"],
      ["Cathédrale","Château"],
      ["Phare","Moulin"],
      ["Bibliothèque","Musée"],
      ["Marché","Foire"],
      ["Carnaval","Festival"],
      ["Théâtre","Opéra"],
      ["Cirque","Cabaret"],
      ["Échecs","Dames"],
      ["Rugby","Football américain"],
      ["Tennis","Badminton"]
    ]
  },
  hasard3: {
    label: "Au hasard 3",
    pairs: [
      ["Château","Palais"],
      ["Forteresse","Donjon"],
      ["Île","Presqu'île"],
      ["Lac","Étang"],
      ["Rivière","Fleuve"],
      ["Colline","Montagne"],
      ["Falaise","Grotte"],
      ["Tempête","Ouragan"],
      ["Tremblement de terre","Éruption volcanique"],
      ["Aurore boréale","Éclipse"],
      ["Comète","Météorite"],
      ["Étoile filante","Constellation"],
      ["Planète","Lune"],
      ["Robot ménager","Aspirateur"],
      ["Frigo","Congélateur"],
      ["Four","Micro-ondes"],
      ["Vélo","Trottinette"],
      ["Avion","Hélicoptère"],
      ["Sous-marin","Bateau de pêche"],
      ["Fusée","Navette spatiale"],
      ["Chevalier","Templier"],
      ["Empereur","Pharaon"],
      ["Gladiateur","Légionnaire romain"],
      ["Moine","Ermite"],
      ["Barde","Troubadour"],
      ["Alchimiste","Apothicaire"],
      ["Horloger","Bijoutier"],
      ["Tailleur","Cordonnier"],
      ["Potier","Verrier"],
      ["Apiculteur","Éleveur"],
      ["Vigneron","Brasseur"],
      ["Fromager","Charcutier"],
      ["Chocolatier","Pâtissier"],
      ["Fleuriste","Jardinier"],
      ["Sommelier","Barman"],
      ["Traiteur","Restaurateur"],
      ["Antiquaire","Brocanteur"],
      ["Marionnette","Poupée"],
      ["Cerf-volant","Ballon"],
      ["Igloo","Tipi"]
    ]
  },
  footballeurs: {
    label: "Footballeurs",
    pairs: [
      ["Lionel Messi","Cristiano Ronaldo"],
      ["Neymar","Kylian Mbappé"],
      ["Ronaldinho","Neymar"],
      ["Pelé","Diego Maradona"],
      ["Zinédine Zidane","Andrés Iniesta"],
      ["Xavi","Andrés Iniesta"],
      ["Kaká","Zinédine Zidane"],
      ["Ronaldo Nazário","Romário"],
      ["Thierry Henry","Didier Drogba"],
      ["Karim Benzema","Olivier Giroud"],
      ["Robert Lewandowski","Erling Haaland"],
      ["Harry Kane","Robert Lewandowski"],
      ["Sergio Agüero","Luis Suárez"],
      ["Luis Suárez","Edinson Cavani"],
      ["Wayne Rooney","Alan Shearer"],
      ["David Beckham","Steven Gerrard"],
      ["Frank Lampard","Steven Gerrard"],
      ["Paul Scholes","Andrea Pirlo"],
      ["Andrea Pirlo","Xabi Alonso"],
      ["Xabi Alonso","Sergio Busquets"],
      ["N'Golo Kanté","Claude Makélélé"],
      ["Patrick Vieira","Roy Keane"],
      ["Roberto Carlos","Marcelo"],
      ["Cafu","Dani Alves"],
      ["Paolo Maldini","Fabio Cannavaro"],
      ["Sergio Ramos","Gerard Piqué"],
      ["Virgil van Dijk","Rio Ferdinand"],
      ["Franz Beckenbauer","Lothar Matthäus"],
      ["Gianluigi Buffon","Iker Casillas"],
      ["Manuel Neuer","Petr Čech"],
      ["Peter Schmeichel","Edwin van der Sar"],
      ["Ronaldinho","Roberto Baggio"],
      ["George Best","Johan Cruyff"],
      ["Johan Cruyff","Marco van Basten"],
      ["Michel Platini","Zinédine Zidane"],
      ["Eric Cantona","Zlatan Ibrahimović"],
      ["Zlatan Ibrahimović","Didier Drogba"],
      ["Antoine Griezmann","Kylian Mbappé"],
      ["Mohamed Salah","Sadio Mané"],
      ["Kevin De Bruyne","David Silva"]
    ]
  },
  sportifs: {
    label: "Sportifs",
    pairs: [
      ["Rafael Nadal","Roger Federer"],
      ["Novak Djokovic","Rafael Nadal"],
      ["Serena Williams","Venus Williams"],
      ["Serena Williams","Naomi Osaka"],
      ["LeBron James","Michael Jordan"],
      ["Kobe Bryant","LeBron James"],
      ["Shaquille O'Neal","Kobe Bryant"],
      ["Magic Johnson","Larry Bird"],
      ["Usain Bolt","Carl Lewis"],
      ["Muhammad Ali","Mike Tyson"],
      ["Floyd Mayweather","Manny Pacquiao"],
      ["Lewis Hamilton","Michael Schumacher"],
      ["Max Verstappen","Lewis Hamilton"],
      ["Alain Prost","Ayrton Senna"],
      ["Michael Phelps","Mark Spitz"],
      ["Tiger Woods","Rory McIlroy"],
      ["Simone Biles","Nadia Comaneci"],
      ["Tony Parker","Nicolas Batum"],
      ["Serena Williams","Steffi Graf"],
      ["Novak Djokovic","Roger Federer"]
    ]
  },
  sportifs2: {
    label: "Sportifs 2",
    pairs: [
      ["Teddy Riner","Tony Yoka"],
      ["Antoine Dupont","Sébastien Chabal"],
      ["Jonah Lomu","Bryan Habana"],
      ["Dan Carter","Jonny Wilkinson"],
      ["Renaud Lavillenie","Sergueï Bubka"],
      ["Kevin Mayer","Ashton Eaton"],
      ["Marie-José Pérec","Florence Griffith-Joyner"],
      ["Laure Manaudou","Camille Muffat"],
      ["Alain Bernard","Florent Manaudou"],
      ["Martin Fourcade","Ole Einar Bjørndalen"],
      ["Jean-Claude Killy","Alberto Tomba"],
      ["Lindsey Vonn","Mikaela Shiffrin"],
      ["Eddy Merckx","Bernard Hinault"],
      ["Tadej Pogačar","Jonas Vingegaard"],
      ["Lance Armstrong","Miguel Indurain"],
      ["Wayne Gretzky","Mario Lemieux"],
      ["Sébastien Loeb","Sébastien Ogier"],
      ["Valentino Rossi","Marc Márquez"],
      ["Yannick Noah","Guy Forget"],
      ["Amélie Mauresmo","Mary Pierce"]
    ]
  }
};

/* ================= Sessions en mémoire ================= */
const impSessions = new Map(); // code -> session
const impClients = new Map();  // code -> Set<{res, playerId}>

function impCode() {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  let c = "";
  for (let i = 0; i < 4; i++) c += letters[Math.floor(Math.random() * letters.length)];
  return c;
}
function impId() { return crypto.randomBytes(8).toString("hex"); }

function impNewSession(hostName) {
  let code;
  do { code = impCode(); } while (impSessions.has(code));
  const hostId = impId();
  const session = {
    code, phase: "lobby", hostId,
    players: new Map([[hostId, { id: hostId, name: hostName }]]),
    numUndercover: 1, numZgeg: 0,
    category: "divers", customA: "", customB: "",
    charA: "", charB: "", roles: {}, order: [],
    clueRound: 1, usedPairs: {},
    createdAt: Date.now()
  };
  impSessions.set(code, session);
  impClients.set(code, new Set());
  return { session, hostId };
}

function impClampRoles(session) {
  const n = session.players.size;
  const max = Math.max(n - 1, 0);
  if (session.numUndercover < 0) session.numUndercover = 0;
  if (session.numZgeg < 0) session.numZgeg = 0;
  if (session.numUndercover > max) session.numUndercover = max;
  if (session.numUndercover + session.numZgeg > max) session.numZgeg = Math.max(max - session.numUndercover, 0);
}

function impPickPair(session) {
  const pool = (CATEGORIES[session.category] || {}).pairs || [];
  if (pool.length === 0) return null;
  const key = p => p[0] + "␟" + p[1];
  if (!session.usedPairs[session.category]) session.usedPairs[session.category] = [];
  let used = session.usedPairs[session.category];
  let available = pool.filter(p => !used.includes(key(p)));
  if (available.length === 0) { used = []; available = pool; }
  const pair = available[Math.floor(Math.random() * available.length)];
  used.push(key(pair));
  session.usedPairs[session.category] = used;
  return pair;
}

function impShuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* ================= Vue adaptée par destinataire (confidentialité) ================= */
function impPayloadFor(session, playerId) {
  const players = [...session.players.values()].map(p => ({ id: p.id, name: p.name }));
  const isHost = playerId === session.hostId;
  const base = {
    code: session.code, phase: session.phase, players, isHost, hostId: session.hostId,
    numUndercover: session.numUndercover, numZgeg: session.numZgeg, category: session.category,
    categories: Object.fromEntries(Object.entries(CATEGORIES).map(([k, v]) => [k, { label: v.label, count: v.pairs.length }])),
    clueRound: session.clueRound
  };
  if (session.phase === "clue") {
    base.order = session.order.map(id => ({ id, name: session.players.get(id)?.name || "?" }));
    const myRole = session.roles[playerId];
    base.myRole = myRole || null;
    base.myCharacter = myRole === "B" ? session.charB : myRole === "A" ? session.charA : null;
  } else if (session.phase === "result") {
    base.order = session.order.map(id => ({ id, name: session.players.get(id)?.name || "?" }));
    base.charA = session.charA; base.charB = session.charB;
    base.roles = session.roles;
  }
  return base;
}

function impBroadcast(code) {
  const session = impSessions.get(code);
  const conns = impClients.get(code);
  if (!session || !conns) return;
  for (const c of conns) {
    try { c.res.write(`data: ${JSON.stringify(impPayloadFor(session, c.playerId))}\n\n`); }
    catch (e) { /* connexion morte, sera nettoyée au 'close' */ }
  }
}

function impSend(res, status, obj){ json(res, obj, status); }

/* routes /imposteur/api/... ; `sub` = segments apres "imposteur" */
async function impApi(req, res, url, sub){
  // SSE : GET /imposteur/api/session/:code/stream?playerId=...
  if (req.method === "GET" && sub[0] === "api" && sub[1] === "session" && sub[3] === "stream") {
    const code = (sub[2] || "").toUpperCase();
    const playerId = url.searchParams.get("playerId");
    const session = impSessions.get(code);
    if (!session || !session.players.has(playerId)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
    res.write(`data: ${JSON.stringify(impPayloadFor(session, playerId))}\n\n`);
    const conn = { res, playerId };
    impClients.get(code).add(conn);
    const keepAlive = setInterval(() => { try { res.write(":ping\n\n"); } catch (e) {} }, 25000);
    req.on("close", () => { clearInterval(keepAlive); impClients.get(code) && impClients.get(code).delete(conn); });
    return;
  }

  // POST /imposteur/api/session   { hostName }
  if (req.method === "POST" && sub[0] === "api" && sub[1] === "session" && sub.length === 2) {
    const b = await lireCorps(req);
    if (!b.hostName || !String(b.hostName).trim()) return impSend(res, 400, { error: "Nom requis" });
    const r = impNewSession(String(b.hostName).trim().slice(0, 20));
    return impSend(res, 200, { code: r.session.code, playerId: r.hostId });
  }

  if (sub[0] === "api" && sub[1] === "session" && sub[2]) {
    const code = sub[2].toUpperCase();
    const session = impSessions.get(code);
    const action = sub[3];

    if (req.method === "POST" && action === "join") {
      if (!session) return impSend(res, 404, { error: "Salon introuvable" });
      const b = await lireCorps(req);
      if (!b.name || !String(b.name).trim()) return impSend(res, 400, { error: "Nom requis" });
      const pid = impId();
      session.players.set(pid, { id: pid, name: String(b.name).trim().slice(0, 20) });
      session.maj = Date.now();
      impBroadcast(code);
      return impSend(res, 200, { playerId: pid });
    }

    if (req.method === "POST" && action === "config") {
      if (!session) return impSend(res, 404, { error: "Salon introuvable" });
      const body = await lireCorps(req);
      if (body.playerId !== session.hostId) return impSend(res, 403, { error: "Reserve a l'hote" });
      if (typeof body.numUndercover === "number") session.numUndercover = body.numUndercover;
      if (typeof body.numZgeg === "number") session.numZgeg = body.numZgeg;
      if (typeof body.category === "string") session.category = body.category;
      if (typeof body.customA === "string") session.customA = body.customA;
      if (typeof body.customB === "string") session.customB = body.customB;
      impClampRoles(session);
      session.maj = Date.now();
      impBroadcast(code);
      return impSend(res, 200, { ok: true });
    }

    if (req.method === "POST" && action === "kick") {
      if (!session) return impSend(res, 404, { error: "Salon introuvable" });
      const body = await lireCorps(req);
      if (body.playerId !== session.hostId) return impSend(res, 403, { error: "Reserve a l'hote" });
      session.players.delete(body.targetId);
      session.maj = Date.now();
      impBroadcast(code);
      return impSend(res, 200, { ok: true });
    }

    if (req.method === "POST" && action === "distribute") {
      if (!session) return impSend(res, 404, { error: "Salon introuvable" });
      const body = await lireCorps(req);
      if (body.playerId !== session.hostId) return impSend(res, 403, { error: "Reserve a l'hote" });
      if (session.players.size < 3) return impSend(res, 400, { error: "Il faut au moins 3 joueurs" });
      impClampRoles(session);
      let charA, charB;
      if (session.customA.trim() && session.customB.trim()) {
        charA = session.customA.trim(); charB = session.customB.trim();
      } else {
        const pair = impPickPair(session);
        if (!pair) return impSend(res, 400, { error: "Categorie vide" });
        charA = pair[0]; charB = pair[1];
      }
      const ids = [...session.players.keys()];
      const order = impShuffle(ids);
      const roles = {};
      order.forEach((id, i) => {
        if (i < session.numUndercover) roles[id] = "B";
        else if (i < session.numUndercover + session.numZgeg) roles[id] = "blank";
        else roles[id] = "A";
      });
      session.charA = charA; session.charB = charB; session.roles = roles; session.order = order;
      session.clueRound = 1; session.phase = "clue";
      session.maj = Date.now();
      impBroadcast(code);
      return impSend(res, 200, { ok: true });
    }

    if (req.method === "POST" && action === "advance") {
      if (!session) return impSend(res, 404, { error: "Salon introuvable" });
      const body = await lireCorps(req);
      if (body.playerId !== session.hostId) return impSend(res, 403, { error: "Reserve a l'hote" });
      if (session.clueRound === 1) session.clueRound = 2;
      else session.phase = "result";
      session.maj = Date.now();
      impBroadcast(code);
      return impSend(res, 200, { ok: true });
    }

    if (req.method === "POST" && action === "lobby") {
      if (!session) return impSend(res, 404, { error: "Salon introuvable" });
      const body = await lireCorps(req);
      if (body.playerId !== session.hostId) return impSend(res, 403, { error: "Reserve a l'hote" });
      session.phase = "lobby";
      session.maj = Date.now();
      impBroadcast(code);
      return impSend(res, 200, { ok: true });
    }
  }

  return impSend(res, 404, { error: "route inconnue" });
}

/* ==================================================================
   FICHIERS STATIQUES + ROUTEUR
   ================================================================== */
function statique(req, res, url){
  let f = decodeURIComponent(url.pathname);
  if(f.indexOf("..") >= 0){ res.writeHead(400); return res.end(); }

  /* un dossier sans barre finale : on redirige pour que les liens relatifs marchent */
  if(f === "/loup-garou" || f === "/imposteur"){
    res.writeHead(302, {Location: f + "/"});
    return res.end();
  }
  if(f === "/") f = "/index.html";
  else if(f.endsWith("/")) f += "index.html";

  const abs = path.join(PUB, f);
  if(!abs.startsWith(PUB)){ res.writeHead(403); return res.end("Interdit"); }
  fs.readFile(abs, function(err, data){
    if(err){ res.writeHead(404, {"Content-Type":"text/plain; charset=utf-8"}); return res.end("Introuvable"); }
    res.writeHead(200, {"Content-Type": MIME[path.extname(abs)] || "application/octet-stream",
      "Cache-Control":"no-cache"});
    res.end(data);
  });
}

const serveur = http.createServer(function(req, res){
  const url = new URL(req.url, "http://" + (req.headers.host || "localhost"));
  const p = url.pathname;

  if(req.method === "OPTIONS"){
    res.writeHead(204, {"Access-Control-Allow-Origin":"*",
      "Access-Control-Allow-Methods":"GET,POST,OPTIONS", "Access-Control-Allow-Headers":"Content-Type"});
    return res.end();
  }

  /* garde-eveille commun aux deux jeux */
  if(p === "/api/ping") return json(res, {ok:true, t:Date.now()});

  /* Imposteur */
  if(p.startsWith("/imposteur/api/")){
    const sub = p.split("/").filter(Boolean).slice(1);   // enleve "imposteur"
    return impApi(req, res, url, sub).catch(function(){ json(res, {ok:false}, 500); });
  }

  /* Loup-Garou */
  if(p.startsWith("/api/")) return lgApi(req, res, url).catch(function(){ json(res, {ok:false}, 500); });
  if(p === "/sse") return lgFlux(req, res, url);

  return statique(req, res, url);
});

/* menage : une session sans activite depuis 8 h disparait, dans les deux jeux */
setInterval(function(){
  const seuil = Date.now() - 8*3600*1000;
  parties.forEach(function(p, c){ if(p.maj < seuil) parties.delete(c); });
  impSessions.forEach(function(s, c){
    const t = s.maj || s.createdAt || 0;
    if(t < seuil){ impSessions.delete(c); impClients.delete(c); }
  });
}, 30*60*1000);

serveur.listen(PORT, function(){
  console.log("Deux jeux en ligne sur http://localhost:" + PORT);
  console.log("  Loup-Garou : /loup-garou/       (meneur : /loup-garou/mj.html)");
  console.log("  Imposteur  : /imposteur/");
});
