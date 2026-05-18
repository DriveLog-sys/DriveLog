/* ============================================================
   DRIVELOG — DATA.JS  (seed data, constants, helpers)
   ============================================================ */

const CATS = [
  { name:'JDM',       fa:'fas fa-sun',             desc:'Japanese domestic market legends',           color:'#e8392a', badge:'badge-jdm'       },
  { name:'Euro',      fa:'fas fa-compass',          desc:'Precision engineering from Europe',           color:'#3b82f6', badge:'badge-euro'      },
  { name:'Muscle',    fa:'fas fa-bolt',             desc:'American horsepower and raw power',           color:'#f0a030', badge:'badge-muscle'    },
  { name:'Classic',   fa:'fas fa-star',             desc:'Timeless machines from golden eras',          color:'#c9a84c', badge:'badge-classic'   },
  { name:'Off-Road',  fa:'fas fa-mountain',         desc:'Built for the dirt, mud, and trails',         color:'#22c55e', badge:'badge-offroad'   },
  { name:'Collector', fa:'fas fa-gem',              desc:'Rare, investment-grade automobiles',          color:'#14b8a6', badge:'badge-collector' },
  { name:'Sports Car',fa:'fas fa-car',               desc:'High-performance sports and GT machines',    color:'#a855f7', badge:'badge-sports'    },
  { name:'Truck',     fa:'fas fa-truck-pickup',     desc:'Full-size haulers and performance pickups',   color:'#78716c', badge:'badge-truck'     },
  { name:'SUV',       fa:'fas fa-car-side',         desc:'Sport utility builds, lifted and tuned',      color:'#0ea5e9', badge:'badge-suv'       },
  { name:'Drift',     fa:'fas fa-wind',             desc:'Angle seekers and sideways specialists',      color:'#f43f5e', badge:'badge-drift'     },
  { name:'Track',     fa:'fas fa-flag-checkered',   desc:'Purpose-built circuit and time attack cars',  color:'#6366f1', badge:'badge-track'     },
  { name:'Drag',      fa:'fas fa-tachometer-alt',   desc:'Straight-line machines built for the strip',  color:'#eab308', badge:'badge-drag'      },
  { name:'Electric',  fa:'fas fa-plug',             desc:'EV builds, conversions, and electric tuners', color:'#4ade80', badge:'badge-electric'  },
  { name:'Supercar',  fa:'fas fa-rocket',           desc:'Exotic and ultra-high-performance machines',  color:'#fb923c', badge:'badge-supercar'  },
  { name:'Hypercar',  fa:'fas fa-rocket',           desc:'Hypercars, ultra-exotics, and track weapons', color:'#ec4899', badge:'badge-hypercar'  },
];

function catCfg(name) { return CATS.find(c => c.name === name) || { color:'#555', badge:'badge-default', fa:'fas fa-car' }; }

const AV_COLORS = {
  A:'#3b82f6',B:'#8b5cf6',C:'#ec4899',D:'#f59e0b',E:'#10b981',F:'#6366f1',
  G:'#14b8a6',H:'#e8392a',I:'#f0a030',J:'#22c55e',K:'#e8392a',L:'#a855f7',
  M:'#3b82f6',N:'#f59e0b',O:'#10b981',P:'#ec4899',Q:'#14b8a6',R:'#f0a030',
  S:'#6366f1',T:'#22c55e',U:'#8b5cf6',V:'#e8392a',W:'#3b82f6',X:'#a855f7',
  Y:'#14b8a6',Z:'#f0a030'
};
function avColor(name) { return AV_COLORS[(name||'?')[0].toUpperCase()] || '#e8392a'; }

const PH_BG = ['#1a0f0f','#0d1714','#0f0f1a','#1a1208','#0d1a16'];
function phBg(id) { return PH_BG[id.charCodeAt(id.length-1) % PH_BG.length]; }

const SEED_POSTS = [];

const SEED_USERS = [];

const SEED_EVENTS = [];

const SEED_TIMELINES = {};

const AWARDS_DEF = [
  { id:'founders',  icon:'fas fa-crown', label:'Founders',  desc:'Awarded to the original founders of DriveLog.',       color:'#fff', bg:'#b45309', border:'#92400e'  },
  { id:'viral',     icon:'fas fa-bolt',  label:'Viral',     desc:'Awarded for a build or post that went truly viral.',   color:'#fff', bg:'#1d4ed8', border:'#1e3a8a'  },
  { id:'honorary',  icon:'fas fa-medal', label:'Honorary',  desc:'Awarded at the discretion of the DriveLog founders.',  color:'#fff', bg:'#7e22ce', border:'#581c87'  },
];
function getAwardDef(id) { return AWARDS_DEF.find(a => a.id === id); }
