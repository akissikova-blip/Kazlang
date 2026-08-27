import { useState, useEffect, useRef } from "react";

// ---------- Storage shim ----------
// In Claude's artifact environment, `window.storage` is provided automatically.
// Outside of it (e.g. this app running on GitHub Pages), we back the same
// async get/set/delete interface with the browser's localStorage instead.
const storage = {
  async get(key) {
    const value = localStorage.getItem(key);
    if (value === null) return null;
    return { key, value, shared: false };
  },
  async set(key, value) {
    localStorage.setItem(key, value);
    return { key, value, shared: false };
  },
  async delete(key) {
    const existed = localStorage.getItem(key) !== null;
    localStorage.removeItem(key);
    return { key, deleted: existed, shared: false };
  },
};

// ---------- Design tokens ----------
const COLORS = {
  sky: "#1F9AF3",
  skyDark: "#0F6FC2",
  sun: "#FFC53D",
  steppe: "#2FCB8C",
  coral: "#FF6B5E",
  pink: "#FF6FA5",
  lilac: "#A78BFA",
  ink: "#16213D",
  cloud: "#F5F8FC",
};

const FONT_LINK_ID = "kz-app-fonts";

function ensureFonts() {
  if (typeof document === "undefined") return;
  if (document.getElementById(FONT_LINK_ID)) return;
  const link = document.createElement("link");
  link.id = FONT_LINK_ID;
  link.rel = "stylesheet";
  link.href =
    "https://fonts.googleapis.com/css2?family=Baloo+2:wght@500;700;800&family=Nunito:wght@400;600;700;800&display=swap";
  document.head.appendChild(link);
}

// ---------- Companions (non-animal, chosen for an 11-year-old girl) ----------
const AVATARS = [
  {
    id: "zhuldyz",
    name: "Жұлдыз",
    sub: "звезда",
    color: COLORS.sky,
    emoji: "⭐",
  },
  {
    id: "aigul",
    name: "Айгүл",
    sub: "лунный цветок",
    color: COLORS.lilac,
    emoji: "🌙",
  },
  {
    id: "aru",
    name: "Ару",
    sub: "красавица",
    color: COLORS.pink,
    emoji: "🌸",
  },
  {
    id: "shattyq",
    name: "Шаттық",
    sub: "радость",
    color: COLORS.sun,
    emoji: "🎀",
  },
];

// ---------- Word bank ----------
const WORDS_STORAGE_KEY = "words";

const CATEGORIES = [
  { id: "house", label: "Дом", emoji: "🏠" },
  { id: "family", label: "Семья", emoji: "👨‍👩‍👧" },
  { id: "school", label: "Школа", emoji: "🎒" },
  { id: "street", label: "Улица", emoji: "🚗" },
  { id: "seasons", label: "Времена года", emoji: "🍂" },
  { id: "colors", label: "Цвета", emoji: "🎨" },
  { id: "numbers", label: "Цифры", emoji: "🔢" },
  { id: "animals", label: "Животные", emoji: "🐾" },
  { id: "food", label: "Еда", emoji: "🍎" },
  { id: "concepts", label: "Понятия", emoji: "💭" },
  { id: "other", label: "Другое", emoji: "📌" },
];

const categoryLabel = (id) => CATEGORIES.find((c) => c.id === id)?.label || id;
const categoryEmoji = (id) => CATEGORIES.find((c) => c.id === id)?.emoji || "📌";

const KZ_LETTERS = ["Ә", "Ғ", "Қ", "Ң", "Ө", "Ұ", "Ү", "Һ"];

function makeWordId() {
  return "w_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7);
}

function normalizeForCompare(s) {
  return (s || "").trim().toLowerCase();
}

// Merge new words into existing ones, skipping exact duplicates (same kz+ru).
function mergeWords(existing, incoming) {
  const seen = new Set(
    existing.map((w) => `${normalizeForCompare(w.kz)}|${normalizeForCompare(w.ru)}`)
  );
  const added = [];
  const skipped = [];
  for (const w of incoming) {
    const key = `${normalizeForCompare(w.kz)}|${normalizeForCompare(w.ru)}`;
    if (!w.kz || !w.ru) {
      skipped.push(w);
      continue;
    }
    if (seen.has(key)) {
      skipped.push(w);
      continue;
    }
    seen.add(key);
    added.push({
      kz: w.kz,
      ru: w.ru,
      id: makeWordId(),
      addedAt: new Date().toISOString(),
      // Test-tracking stats, updated every time this word appears in a test.
      // `history` keeps a full log of past attempts (capped). `intervalIndex`
      // and `nextReviewDate` drive the spaced-repetition schedule below.
      stats: {
        correct: 0,
        wrong: 0,
        lastResult: null,
        lastTestedAt: null,
        history: [],
        intervalIndex: -1, // -1 = never reviewed yet (still "new")
        nextReviewDate: null,
      },
    });
  }
  return { merged: [...existing, ...added], added, skipped };
}

// Spaced-repetition schedule: how many days to wait before the next review,
// indexed by how many times in a row the word has been answered correctly.
// A wrong answer steps back one level (not all the way to the start) — a
// single slip doesn't erase all prior progress, which matters for a child
// who already finds the language hard.
const REVIEW_INTERVALS_DAYS = [1, 3, 7, 14, 30];

function addDays(isoDate, days) {
  const d = new Date(isoDate);
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

// Records the result of one test answer for a word. Returns the updated
// words array — caller should save it.
const MAX_HISTORY_PER_WORD = 20;

function recordWordResult(words, wordId, isCorrect) {
  return words.map((w) => {
    if (w.id !== wordId) return w;
    const stats = w.stats || {
      correct: 0,
      wrong: 0,
      lastResult: null,
      lastTestedAt: null,
      history: [],
      intervalIndex: -1,
      nextReviewDate: null,
    };
    const now = new Date().toISOString();
    const history = [...(stats.history || []), { date: now, correct: isCorrect }].slice(
      -MAX_HISTORY_PER_WORD
    );
    const prevIndex = stats.intervalIndex ?? -1;
    const nextIndex = isCorrect
      ? Math.min(prevIndex + 1, REVIEW_INTERVALS_DAYS.length - 1)
      : Math.max(prevIndex - 1, 0);
    const nextReviewDate = addDays(now, REVIEW_INTERVALS_DAYS[nextIndex]);
    return {
      ...w,
      stats: {
        correct: stats.correct + (isCorrect ? 1 : 0),
        wrong: stats.wrong + (isCorrect ? 0 : 1),
        lastResult: isCorrect ? "correct" : "wrong",
        lastTestedAt: now,
        history,
        intervalIndex: nextIndex,
        nextReviewDate,
      },
    };
  });
}

const isWordTested = (w) => (w.stats?.correct || 0) + (w.stats?.wrong || 0) > 0;

// Words never attempted yet — the "Новые слова" tab. Studied in the order
// they were added, in batches (`limit` = one portion at a time).
function getNewWordsQueue(words, limit = 10) {
  return words.filter((w) => !isWordTested(w)).slice(0, limit);
}

// Words whose scheduled review date has arrived — the "Повторение" tab.
// Most-overdue words come first.
function getDueReviewQueue(words, limit = 10) {
  const now = new Date().toISOString();
  return words
    .filter((w) => isWordTested(w) && w.stats?.nextReviewDate && w.stats.nextReviewDate <= now)
    .sort((a, b) => (a.stats.nextReviewDate || "").localeCompare(b.stats.nextReviewDate || ""))
    .slice(0, limit);
}

// How many words are due right now — for the "к повторению сегодня" counter.
function getDueReviewCount(words) {
  const now = new Date().toISOString();
  return words.filter((w) => isWordTested(w) && w.stats?.nextReviewDate && w.stats.nextReviewDate <= now).length;
}

// "Повторить с начала": every previously-studied word, regardless of
// schedule, shuffled — for a full voluntary refresher whenever the child
// wants one, without waiting for anything to come due.
function getPracticeQueue(words, limit = 10) {
  const studied = words.filter(isWordTested);
  const pool = studied.length > 0 ? studied : words;
  return shuffle(pool).slice(0, limit);
}

// For the supplementary games (Word Builder, Fill Blank) that don't have
// separate New/Review tabs of their own: new words first, then whatever is
// due for review, filling up to `limit`.
function getMixedQueue(words, limit = 10) {
  const newWords = getNewWordsQueue(words, limit);
  if (newWords.length >= limit) return newWords;
  const due = getDueReviewQueue(words, limit - newWords.length);
  return [...newWords, ...due];
}

// "Боss level": a cumulative test over everything the child has already
// studied (words that have appeared in at least one test before) — brand-new,
// never-tested words are excluded since they haven't been "passed material" yet.
// Ordered sequentially by when each word was first added, so the test walks
// through the material in the same order it was learned.
function getBossLevelQueue(words) {
  const studied = words.filter(isWordTested);
  return [...studied].sort((a, b) => new Date(a.addedAt) - new Date(b.addedAt));
}

// Words that keep coming back up across multiple test sessions (not just a
// single wrong answer) — useful for a parent/progress view of what's "stuck".
function getRepeatedlyTestedWords(words, minTimes = 2) {
  return words
    .filter((w) => (w.stats?.history?.length || 0) >= minTimes)
    .sort((a, b) => (b.stats.history.length || 0) - (a.stats.history.length || 0));
}

// Splits one CSV line respecting double-quoted fields (so translations
// like "значение, важность" don't get cut at the inner comma).
function splitCsvLine(line) {
  const result = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      result.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  result.push(cur);
  return result.map((p) => p.trim());
}

// Parses a CSV, TSV, TXT, or JSON file's text content into raw {kz, ru} rows.
// A third "category" column, if present (old-format files), is simply ignored.
function parseWordFile(text, filename) {
  const lowerName = filename.toLowerCase();
  const isJson = lowerName.endsWith(".json") || text.trim().startsWith("[");
  if (isJson) {
    try {
      const data = JSON.parse(text);
      if (!Array.isArray(data)) throw new Error("not an array");
      return data.map((row) => ({
        kz: (row.kz || row.kazakh || row.qazaq || "").toString().trim(),
        ru: (row.ru || row.russian || row.rus || "").toString().trim(),
      }));
    } catch (e) {
      throw new Error("Не удалось прочитать JSON-файл");
    }
  }

  // .txt: free-form text, one pair per line — reuse the same lenient parser
  // as the photo quick-entry field (handles dash/colon/tab, with or without
  // spaces, and strips bullet markers).
  if (lowerName.endsWith(".txt")) {
    return parseQuickLines(text);
  }

  // CSV/TSV: comma-separated by default, but a line containing a tab is
  // treated as tab-separated (so renaming a .tsv export to .csv still works).
  // Wrap a comma-containing field in double quotes, e.g. "значение, важность".
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const parts = rawLine.includes("\t")
      ? rawLine.split("\t").map((p) => p.trim())
      : splitCsvLine(rawLine);
    if (i === 0) {
      const first = normalizeForCompare(parts[0]);
      if (first === "kazakh" || first === "казахский" || first === "kz" || first === "қазақша") {
        continue; // skip header row
      }
    }
    if (parts.length < 2) continue;
    rows.push({ kz: parts[0] || "", ru: parts[1] || "" });
  }
  return rows;
}

// Simple "qoshkar-muiz" (ram-horn) inspired ornament strip, drawn as SVG.
function OrnamentStrip({ color = COLORS.sun, opacity = 1 }) {
  const unit = (
    <path
      d="M0 10 C 3 2, 7 2, 10 10 C 13 18, 17 18, 20 10"
      stroke={color}
      strokeWidth="2.2"
      fill="none"
      strokeLinecap="round"
    />
  );
  const units = Array.from({ length: 9 });
  return (
    <svg
      viewBox="0 0 180 20"
      width="100%"
      height="16"
      style={{ display: "block", opacity }}
      preserveAspectRatio="none"
    >
      {units.map((_, i) => (
        <g key={i} transform={`translate(${i * 20}, 0)`}>
          {unit}
        </g>
      ))}
    </svg>
  );
}

export default function AuthModule() {
  const [stage, setStage] = useState("loading"); // loading | login | home
  const [name, setName] = useState("");
  const [selectedAvatar, setSelectedAvatar] = useState(null);
  const [error, setError] = useState("");
  const [transitioning, setTransitioning] = useState(false);
  const [profile, setProfile] = useState(null);
  const [words, setWords] = useState([]);
  const [learnMode, setLearnMode] = useState("new"); // "new" | "review" | "practice"

  // Check for an existing saved profile + word bank on mount
  useEffect(() => {
    ensureFonts();
    (async () => {
      try {
        const result = await storage.get(WORDS_STORAGE_KEY);
        if (result && result.value) {
          setWords(JSON.parse(result.value));
        }
      } catch (e) {
        // no word bank saved yet — that's fine
      }
      try {
        const result = await storage.get("profile");
        if (result && result.value) {
          const parsed = JSON.parse(result.value);
          setProfile(parsed);
          setStage("home");
          return;
        }
      } catch (e) {
        // no profile saved yet — that's fine
      }
      setStage("login");
    })();
  }, []);

  const saveWords = async (nextWords) => {
    setWords(nextWords);
    try {
      await storage.set(WORDS_STORAGE_KEY, JSON.stringify(nextWords));
    } catch (e) {
      console.error("Storage error:", e);
    }
  };

  const goTo = (next) => {
    setTransitioning(true);
    setTimeout(() => {
      setStage(next);
      setTransitioning(false);
    }, 220);
  };

  const handleStart = async () => {
    const trimmed = name.trim();
    if (trimmed.length < 2) {
      setError("Впиши имя (минимум 2 буквы)");
      return;
    }
    if (!selectedAvatar) {
      setError("Выбери спутника");
      return;
    }
    setError("");
    const newProfile = { name: trimmed, avatarId: selectedAvatar, level: 0, xp: 0 };
    try {
      await storage.set("profile", JSON.stringify(newProfile));
    } catch (e) {
      // storage failed — still let them continue in-session
      console.error("Storage error:", e);
    }
    setProfile(newProfile);
    goTo("home");
  };

  const handleSwitchProfile = async () => {
    try {
      await storage.delete("profile");
    } catch (e) {
      // ignore
    }
    setProfile(null);
    setName("");
    setSelectedAvatar(null);
    goTo("login");
  };

  // Renames the current profile in place — words and stats are untouched,
  // this only ever writes the "profile" key, never the "words" key.
  const handleUpdateName = async (newName) => {
    const trimmed = newName.trim();
    if (trimmed.length < 2 || !profile) return;
    const updatedProfile = { ...profile, name: trimmed };
    setProfile(updatedProfile);
    try {
      await storage.set("profile", JSON.stringify(updatedProfile));
    } catch (e) {
      console.error("Storage error:", e);
    }
  };

  // Records one answer's result. Uses the functional setWords form so it
  // always applies on top of the truly latest state — never a stale snapshot
  // from whenever this screen was first rendered — which matters because a
  // whole learning session fires several of these in a row.
  const handleRecordResult = (wordId, isCorrect) => {
    setWords((prevWords) => {
      const updated = recordWordResult(prevWords, wordId, isCorrect);
      storage.set(WORDS_STORAGE_KEY, JSON.stringify(updated)).catch((e) => console.error("Storage error:", e));
      return updated;
    });
  };

  const avatarObj = (id) => AVATARS.find((a) => a.id === id);

  return (
    <div
      style={{
        minHeight: "100vh",
        width: "100%",
        background: `linear-gradient(180deg, ${COLORS.cloud} 0%, #EAF3FF 100%)`,
        display: "flex",
        justifyContent: "center",
        alignItems: "stretch",
        fontFamily: "'Nunito', sans-serif",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 420,
          minHeight: "100vh",
          background: "#fff",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 0 40px rgba(15,111,194,0.08)",
          position: "relative",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            opacity: transitioning ? 0 : 1,
            transform: transitioning ? "translateY(8px)" : "translateY(0)",
            transition: "opacity 0.22s ease, transform 0.22s ease",
            display: "flex",
            flexDirection: "column",
            flex: 1,
          }}
        >
          {stage === "loading" && <LoadingScreen />}
          {stage === "login" && (
            <LoginScreen
              name={name}
              setName={setName}
              selectedAvatar={selectedAvatar}
              setSelectedAvatar={setSelectedAvatar}
              error={error}
              onStart={handleStart}
            />
          )}
          {stage === "home" && profile && (
            <HomeScreen
              profile={profile}
              avatar={avatarObj(profile.avatarId)}
              onSwitchProfile={handleSwitchProfile}
              onUpdateName={handleUpdateName}
              onOpenWords={() => goTo("words")}
              onStartNew={() => { setLearnMode("new"); goTo("learn"); }}
              onStartReview={() => { setLearnMode("review"); goTo("learn"); }}
              onStartPractice={() => { setLearnMode("practice"); goTo("learn"); }}
              onOpenWordBuilder={() => goTo("wordbuilder")}
              onOpenFillBlank={() => goTo("fillblank")}
              onOpenBoss={() => goTo("boss")}
              onOpenParent={() => goTo("parent")}
              wordCount={words.length}
              newWordsCount={getNewWordsQueue(words, Infinity).length}
              dueReviewCount={getDueReviewCount(words)}
              hasStudiedWords={words.some(isWordTested)}
            />
          )}
          {stage === "words" && (
            <WordBank
              words={words}
              onSaveWords={saveWords}
              onBack={() => goTo("home")}
            />
          )}
          {stage === "learn" && (
            <LearnSession
              words={words}
              mode={learnMode}
              onRecordResult={handleRecordResult}
              onFinish={() => goTo("home")}
            />
          )}
          {stage === "wordbuilder" && (
            <WordBuilderGame
              words={words}
              onRecordResult={handleRecordResult}
              onFinish={() => goTo("home")}
            />
          )}
          {stage === "fillblank" && (
            <FillBlankGame
              words={words}
              onRecordResult={handleRecordResult}
              onFinish={() => goTo("home")}
            />
          )}
          {stage === "boss" && (
            <BossLevel
              words={words}
              onRecordResult={handleRecordResult}
              onFinish={() => goTo("home")}
            />
          )}
          {stage === "parent" && (
            <ParentDashboard words={words} profile={profile} onBack={() => goTo("home")} />
          )}
        </div>
      </div>
    </div>
  );
}

function LoadingScreen() {
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div style={{ fontFamily: "'Baloo 2', sans-serif", color: COLORS.skyDark, fontSize: 18 }}>
        Загрузка...
      </div>
    </div>
  );
}

function LoginScreen({ name, setName, selectedAvatar, setSelectedAvatar, error, onStart }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Header */}
      <div
        style={{
          background: `linear-gradient(135deg, ${COLORS.sky} 0%, ${COLORS.skyDark} 100%)`,
          padding: "36px 24px 20px",
          color: "#fff",
        }}
      >
        <div
          style={{
            fontFamily: "'Baloo 2', sans-serif",
            fontWeight: 800,
            fontSize: 26,
            letterSpacing: 0.2,
          }}
        >
          Тіл Батыры
        </div>
        <div style={{ fontSize: 14, opacity: 0.9, marginTop: 4 }}>
          Учи казахский — получай новые звания!
        </div>
      </div>
      <OrnamentStrip color={COLORS.sun} />

      {/* Body */}
      <div style={{ flex: 1, padding: "24px", display: "flex", flexDirection: "column", gap: 22 }}>
        <div>
          <div
            style={{
              fontFamily: "'Baloo 2', sans-serif",
              fontWeight: 700,
              fontSize: 16,
              color: COLORS.ink,
              marginBottom: 8,
            }}
          >
            Как тебя зовут?
          </div>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Напиши своё имя..."
            maxLength={20}
            style={{
              width: "100%",
              boxSizing: "border-box",
              padding: "14px 18px",
              borderRadius: 999,
              border: `2px solid #E1E8F5`,
              fontSize: 16,
              fontFamily: "'Nunito', sans-serif",
              fontWeight: 700,
              color: COLORS.ink,
              outline: "none",
            }}
            onFocus={(e) => (e.target.style.borderColor = COLORS.sky)}
            onBlur={(e) => (e.target.style.borderColor = "#E1E8F5")}
          />
        </div>

        <div>
          <div
            style={{
              fontFamily: "'Baloo 2', sans-serif",
              fontWeight: 700,
              fontSize: 16,
              color: COLORS.ink,
              marginBottom: 10,
            }}
          >
            Выбери своего спутника
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 12,
            }}
          >
            {AVATARS.map((a) => {
              const active = selectedAvatar === a.id;
              return (
                <button
                  key={a.id}
                  onClick={() => setSelectedAvatar(a.id)}
                  style={{
                    cursor: "pointer",
                    border: active ? `3px solid ${a.color}` : "3px solid transparent",
                    background: active ? `${a.color}1A` : "#F5F8FC",
                    borderRadius: 20,
                    padding: "16px 8px 12px",
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    gap: 4,
                    transition: "all 0.15s ease",
                    transform: active ? "scale(1.03)" : "scale(1)",
                  }}
                >
                  <div style={{ fontSize: 34 }}>{a.emoji}</div>
                  <div
                    style={{
                      fontFamily: "'Baloo 2', sans-serif",
                      fontWeight: 700,
                      fontSize: 14,
                      color: COLORS.ink,
                    }}
                  >
                    {a.name}
                  </div>
                  <div style={{ fontSize: 11, color: "#7A8AA6" }}>{a.sub}</div>
                </button>
              );
            })}
          </div>
        </div>

        {error && (
          <div
            style={{
              color: COLORS.coral,
              fontWeight: 700,
              fontSize: 13,
              textAlign: "center",
            }}
          >
            {error}
          </div>
        )}
      </div>

      {/* CTA */}
      <div style={{ padding: "0 24px 32px" }}>
        <button
          onClick={onStart}
          style={{
            width: "100%",
            padding: "16px",
            borderRadius: 999,
            border: "none",
            background: `linear-gradient(135deg, ${COLORS.sun} 0%, #FFB020 100%)`,
            color: COLORS.ink,
            fontFamily: "'Baloo 2', sans-serif",
            fontWeight: 800,
            fontSize: 17,
            cursor: "pointer",
            boxShadow: "0 8px 20px rgba(255,197,61,0.45)",
          }}
        >
          Начать 🚀
        </button>
      </div>
    </div>
  );
}

// ---------- On-demand OCR (Tesseract.js loaded from CDN, not bundled) ----------
// Loaded lazily via a <script> tag (not a static import) so that if the
// network/sandbox blocks it, only the "recognize text" button fails —
// nothing else in the app breaks.
let tesseractLoadPromise = null;
function loadTesseract() {
  if (typeof window !== "undefined" && window.Tesseract) return Promise.resolve(window.Tesseract);
  if (tesseractLoadPromise) return tesseractLoadPromise;
  tesseractLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/4.1.1/tesseract.min.js";
    script.onload = () => {
      if (window.Tesseract) resolve(window.Tesseract);
      else reject(new Error("Библиотека загрузилась, но не инициализировалась"));
    };
    script.onerror = () => reject(new Error("Не удалось загрузить библиотеку распознавания (нет сети?)"));
    document.head.appendChild(script);
  });
  return tesseractLoadPromise;
}

// Parses quick free-typed lines (used with the "photo helper") into {kz, ru}
// pairs. Deliberately lenient about the separator, since people type these by
// hand while glancing at a screenshot: em/en dash, plain hyphen, colon, tab,
// or even just a double space between the two words all work, with or
// without surrounding spaces (e.g. "Үй-дом", "Үй — дом", "Үй: дом").
function parseQuickLines(text) {
  const ALL_SEPARATORS = /—|–|:|\t|\s-\s|-|\s{2,}/g;
  return text
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/^[\s○•*\d.)]+/, "") // strip bullet/number markers
        // A round bullet (○) is often misread by OCR as a stray letter/symbol
        // (o, O, О, 0, °, ©, ®, ·, *) — and OCR sometimes even turns the gap
        // after it into a fake dash. The lookahead only strips this noise
        // when it's immediately followed by whitespace or a separator (never
        // when more letters follow), so real words are never touched.
        .replace(/^([oOО0°©®·*]{1,3})(?=[\s—–:\t-])[\s—–:\t-]*/, "")
        .trim()
    )
    .filter((line) => line.length > 0)
    .map((line) => {
      const matches = [...line.matchAll(ALL_SEPARATORS)];
      if (matches.length === 0) return null;
      // Prefer a split that leaves at least 2 characters on the left — a
      // 1-character "word" right before the separator is almost always a
      // leftover OCR artifact, not a real Kazakh word.
      const chosen = matches.find((m) => m.index >= 2) || matches[0];
      const sepIndex = chosen.index;
      const sepLen = chosen[0].length;
      const kz = line.slice(0, sepIndex).trim();
      const ru = line.slice(sepIndex + sepLen).trim();
      if (!kz || !ru) return null;
      return { kz, ru };
    })
    .filter(Boolean);
}

function WordBank({ words, onSaveWords, onBack }) {
  const [kz, setKz] = useState("");
  const [ru, setRu] = useState("");
  const [status, setStatus] = useState(null); // { type: 'ok'|'error', text }
  const [photoUrl, setPhotoUrl] = useState(null); // temporary, in-memory only — never saved
  const [quickText, setQuickText] = useState("");
  const [ocr, setOcr] = useState({ status: "idle", progress: 0 }); // idle | loading-lib | recognizing | done | error
  const kzInputRef = useRef(null);
  const fileInputRef = useRef(null);
  const photoInputRef = useRef(null);

  // photoUrl holds a data: URL built in-memory via FileReader — it is never
  // written to storage, and clearing state (setPhotoUrl(null)) is all that's
  // needed to drop it; nothing further to revoke.
  const handlePhotoSelect = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setPhotoUrl(reader.result);
      setQuickText("");
      setStatus(null);
      setOcr({ status: "idle", progress: 0 });
    };
    reader.onerror = () => {
      setStatus({ type: "error", text: "Не удалось открыть фото. Попробуй другой файл." });
    };
    reader.readAsDataURL(file);
  };

  const handleQuickAdd = () => {
    if (quickText.trim().length === 0) {
      setStatus({ type: "error", text: "Поле пустое — сначала впиши слова" });
      return;
    }
    const rows = parseQuickLines(quickText);
    if (rows.length === 0) {
      setStatus({ type: "error", text: "Не нашёл ни одной пары «слово — перевод». Формат: Үй — дом" });
      return;
    }
    const { merged, added, skipped } = mergeWords(words, rows);
    onSaveWords(merged);
    setStatus({
      type: "ok",
      text: `Добавлено: ${added.length}${skipped.length ? `, пропущено (дубли/пустые): ${skipped.length}` : ""}`,
    });
    setQuickText("");
  };

  const handleDiscardPhoto = () => {
    setPhotoUrl(null);
    setQuickText("");
    setOcr({ status: "idle", progress: 0 });
    if (photoInputRef.current) photoInputRef.current.value = "";
  };

  const handleRecognize = async () => {
    if (!photoUrl) return;
    setOcr({ status: "loading-lib", progress: 0 });
    try {
      const Tesseract = await loadTesseract();
      setOcr({ status: "recognizing", progress: 0 });
      const { data } = await Tesseract.recognize(photoUrl, "kaz+rus", {
        logger: (m) => {
          if (m.status === "recognizing text") {
            setOcr({ status: "recognizing", progress: Math.round((m.progress || 0) * 100) });
          }
        },
      });
      setQuickText((data.text || "").trim());
      setOcr({ status: "done", progress: 100 });
      setStatus({
        type: "ok",
        text: "Текст распознан — проверь буквы Ә/Ғ/Қ/Ң/Ө/Ұ/Ү/Һ в поле ниже и поправь при необходимости, потом нажми «Добавить в базу».",
      });
    } catch (err) {
      console.error("OCR error:", err);
      setOcr({ status: "error", progress: 0 });
      setStatus({
        type: "error",
        text: "Не получилось распознать фото автоматически (возможно, сеть заблокирована в этом предпросмотре — на опубликованном сайте должно сработать). Пока впиши слова вручную ниже.",
      });
    }
  };

  const insertLetter = (letter) => {
    const input = kzInputRef.current;
    if (!input) {
      setKz((prev) => prev + letter);
      return;
    }
    const start = input.selectionStart ?? kz.length;
    const end = input.selectionEnd ?? kz.length;
    const next = kz.slice(0, start) + letter + kz.slice(end);
    setKz(next);
    requestAnimationFrame(() => {
      input.focus();
      input.setSelectionRange(start + letter.length, start + letter.length);
    });
  };

  const handleAddManual = () => {
    const trimmedKz = kz.trim();
    const trimmedRu = ru.trim();
    if (!trimmedKz || !trimmedRu) {
      setStatus({ type: "error", text: "Заполни оба поля: слово и перевод" });
      return;
    }
    const { merged, added } = mergeWords(words, [{ kz: trimmedKz, ru: trimmedRu }]);
    if (added.length === 0) {
      setStatus({ type: "error", text: "Такое слово уже есть в базе" });
      return;
    }
    onSaveWords(merged);
    setKz("");
    setRu("");
    setStatus({ type: "ok", text: `Добавлено: ${trimmedKz} — ${trimmedRu}` });
  };

  const [pasteText, setPasteText] = useState("");

  const handlePasteAdd = () => {
    if (pasteText.trim().length === 0) {
      setStatus({ type: "error", text: "Поле пустое — сначала вставь список" });
      return;
    }
    const rows = parseQuickLines(pasteText);
    if (rows.length === 0) {
      setStatus({ type: "error", text: "Не нашёл ни одной пары «слово — перевод». Формат: Үй — дом" });
      return;
    }
    const { merged, added, skipped } = mergeWords(words, rows);
    onSaveWords(merged);
    setStatus({
      type: "ok",
      text: `Добавлено: ${added.length}${skipped.length ? `, пропущено (дубли/пустые): ${skipped.length}` : ""}`,
    });
    setPasteText("");
  };

  const handleFileChange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const rows = parseWordFile(text, file.name);
      if (rows.length === 0) {
        setStatus({ type: "error", text: "В файле не нашлось строк со словами" });
        return;
      }
      const { merged, added, skipped } = mergeWords(words, rows);
      onSaveWords(merged);
      setStatus({
        type: "ok",
        text: `Добавлено новых слов: ${added.length}${
          skipped.length ? `, пропущено (дубли/пустые): ${skipped.length}` : ""
        }`,
      });
    } catch (err) {
      setStatus({ type: "error", text: err.message || "Не удалось прочитать файл" });
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleDelete = (id) => {
    onSaveWords(words.filter((w) => w.id !== id));
  };

  // --- Multi-select delete ---
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const dragRef = useRef({ active: false, mode: null, visited: new Set() });

  const toggleSelectMode = () => {
    setSelectMode((v) => !v);
    setSelectedIds(new Set());
  };

  const applyDragMode = (id) => {
    if (dragRef.current.visited.has(id)) return;
    dragRef.current.visited.add(id);
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (dragRef.current.mode === "select") next.add(id);
      else next.delete(id);
      return next;
    });
  };

  // Starting a drag on a row decides the mode for the whole gesture: if that
  // row wasn't selected yet, this swipe selects everything it touches; if it
  // was already selected, this swipe instead clears the ones it touches —
  // so running your finger back over a mistaken selection un-selects it.
  const handleRowPointerDown = (id) => {
    if (!selectMode) return;
    const mode = selectedIds.has(id) ? "deselect" : "select";
    dragRef.current = { active: true, mode, visited: new Set() };
    applyDragMode(id);
  };

  useEffect(() => {
    if (!selectMode) return;
    const handleMove = (e) => {
      if (!dragRef.current.active) return;
      const point = e.touches ? e.touches[0] : e;
      const el = document.elementFromPoint(point.clientX, point.clientY);
      const rowEl = el && el.closest ? el.closest("[data-select-row]") : null;
      if (rowEl) applyDragMode(rowEl.getAttribute("data-select-row"));
    };
    const handleUp = () => {
      dragRef.current.active = false;
    };
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    window.addEventListener("pointercancel", handleUp);
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      window.removeEventListener("pointercancel", handleUp);
    };
  }, [selectMode]);

  const handleDeleteSelected = () => {
    onSaveWords(words.filter((w) => !selectedIds.has(w.id)));
    setSelectedIds(new Set());
    setSelectMode(false);
  };

  // --- Inline row editing ---
  const [editingId, setEditingId] = useState(null);
  const [editDraft, setEditDraft] = useState({ kz: "", ru: "" });

  const startEdit = (word) => {
    setEditingId(word.id);
    setEditDraft({ kz: word.kz, ru: word.ru });
  };

  const cancelEdit = () => {
    setEditingId(null);
  };

  const saveEdit = (id) => {
    const trimmedKz = editDraft.kz.trim();
    const trimmedRu = editDraft.ru.trim();
    if (!trimmedKz || !trimmedRu) return;
    onSaveWords(words.map((w) => (w.id === id ? { ...w, kz: trimmedKz, ru: trimmedRu } : w)));
    setEditingId(null);
  };

  const wordPriority = (w) => {
    if (!isWordTested(w)) return 0; // new — never tested, highest priority
    const due = w.stats?.nextReviewDate && w.stats.nextReviewDate <= new Date().toISOString();
    if (due) return 1; // due for review today
    return 2; // scheduled for later
  };
  const sortedWords = [...words].sort((a, b) => {
    const p = wordPriority(a) - wordPriority(b);
    if (p !== 0) return p;
    return (a.stats?.nextReviewDate || "").localeCompare(b.stats?.nextReviewDate || "");
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Header */}
      <div
        style={{
          background: `linear-gradient(135deg, ${COLORS.steppe} 0%, #1E9E6C 100%)`,
          padding: "28px 24px 20px",
          color: "#fff",
          display: "flex",
          alignItems: "center",
          gap: 12,
        }}
      >
        <button
          onClick={onBack}
          style={{
            border: "none",
            background: "rgba(255,255,255,0.2)",
            color: "#fff",
            borderRadius: "50%",
            width: 36,
            height: 36,
            fontSize: 16,
            cursor: "pointer",
          }}
        >
          ←
        </button>
        <div>
          <div style={{ fontFamily: "'Baloo 2', sans-serif", fontWeight: 800, fontSize: 20 }}>
            База слов
          </div>
          <div style={{ fontSize: 12, opacity: 0.9 }}>Всего слов: {words.length}</div>
        </div>
      </div>
      <OrnamentStrip color={COLORS.sun} />

      <div style={{ flex: 1, overflowY: "auto", padding: 24, display: "flex", flexDirection: "column", gap: 20 }}>
        {/* Manual add form */}
        <div style={{ background: COLORS.cloud, borderRadius: 18, padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ fontFamily: "'Baloo 2', sans-serif", fontWeight: 700, fontSize: 14, color: COLORS.ink }}>
            Добавить слово вручную
          </div>

          <input
            ref={kzInputRef}
            value={kz}
            onChange={(e) => setKz(e.target.value)}
            placeholder="Слово на казахском"
            style={inputStyle}
          />

          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {KZ_LETTERS.map((l) => (
              <button
                key={l}
                onClick={() => insertLetter(l)}
                style={{
                  border: "none",
                  background: "#fff",
                  borderRadius: 8,
                  width: 30,
                  height: 30,
                  fontWeight: 700,
                  color: COLORS.skyDark,
                  cursor: "pointer",
                  fontSize: 14,
                }}
              >
                {l}
              </button>
            ))}
          </div>

          <input
            value={ru}
            onChange={(e) => setRu(e.target.value)}
            placeholder="Перевод на русском"
            style={inputStyle}
          />

          <button
            onClick={handleAddManual}
            style={{
              border: "none",
              borderRadius: 999,
              padding: "12px",
              background: `linear-gradient(135deg, ${COLORS.sun} 0%, #FFB020 100%)`,
              color: COLORS.ink,
              fontFamily: "'Baloo 2', sans-serif",
              fontWeight: 800,
              cursor: "pointer",
            }}
          >
            Добавить слово
          </button>
        </div>

        {/* Paste a whole list of words as plain text */}
        <div style={{ background: COLORS.cloud, borderRadius: 18, padding: 16, display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontFamily: "'Baloo 2', sans-serif", fontWeight: 700, fontSize: 14, color: COLORS.ink }}>
            Вставить список текстом
          </div>
          <div style={{ fontSize: 12, color: "#7A8AA6", lineHeight: 1.5 }}>
            Удобно, если список уже где-то напечатан — просто скопируй и вставь целиком, по одному слову на строку: <code>Слово — перевод</code>.
          </div>
          <textarea
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            placeholder={"Отбасы — семья\nҮй — дом\nБала — ребенок\n..."}
            rows={6}
            style={{ ...inputStyle, fontFamily: "'Nunito', sans-serif", resize: "vertical" }}
          />
          <button
            onClick={handlePasteAdd}
            style={{
              border: "none",
              borderRadius: 999,
              padding: "12px",
              background: `linear-gradient(135deg, ${COLORS.steppe} 0%, #1E9E6C 100%)`,
              color: "#fff",
              fontFamily: "'Baloo 2', sans-serif",
              fontWeight: 800,
              cursor: "pointer",
            }}
          >
            Добавить весь список
          </button>
        </div>

        {/* File upload */}
        <div style={{ background: COLORS.cloud, borderRadius: 18, padding: 16, display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontFamily: "'Baloo 2', sans-serif", fontWeight: 700, fontSize: 14, color: COLORS.ink }}>
            Загрузить файлом
          </div>
          <div style={{ fontSize: 12, color: "#7A8AA6", lineHeight: 1.5 }}>
            Принимаю несколько форматов:
            <br />• <b>CSV</b>: <code>kazakh,russian</code> в каждой строке (запятую внутри перевода бери в кавычки: <code>{`сөз,"значение, важность"`}</code>)
            <br />• <b>TSV</b>: то же самое, но между словом и переводом — табуляция (как при копировании из Excel/Google Таблиц)
            <br />• <b>TXT</b>: просто текст, по одной паре на строку — тире, дефис или двоеточие между словами: <code>Үй — дом</code>
            <br />• <b>JSON</b>: массив объектов <code>{`{kz, ru}`}</code>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,.tsv,.txt,.json,text/csv,text/tab-separated-values,text/plain,application/json"
            onChange={handleFileChange}
            style={{ fontSize: 13 }}
          />
        </div>

        {/* Temporary photo helper — the photo itself is never saved anywhere;
            it only lives in this component's memory and is discarded as soon
            as you're done or navigate away. */}
        <div style={{ background: COLORS.cloud, borderRadius: 18, padding: 16, display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontFamily: "'Baloo 2', sans-serif", fontWeight: 700, fontSize: 14, color: COLORS.ink }}>
            Перенос со скриншота/фото (с распознаванием)
          </div>
          <div style={{ fontSize: 12, color: "#7A8AA6", lineHeight: 1.5 }}>
            Фото не сохраняется — используется только для распознавания и сразу отбрасывается. Нажми «Распознать текст», проверь результат (особенно буквы Ә/Ғ/Қ/Ң/Ө/Ұ/Ү/Һ) и поправь при необходимости — или впиши слова вручную. Формат строки: <code>Слово — перевод</code>.
          </div>
          <input ref={photoInputRef} type="file" accept="image/*" onChange={handlePhotoSelect} style={{ fontSize: 13 }} />

          {photoUrl && (
            <>
              <img
                src={photoUrl}
                alt="Временное фото со словами"
                style={{ maxWidth: "100%", maxHeight: 220, borderRadius: 12, objectFit: "contain", border: "1px solid #E1E8F5" }}
              />

              <button
                onClick={handleRecognize}
                disabled={ocr.status === "loading-lib" || ocr.status === "recognizing"}
                style={{
                  border: "none",
                  borderRadius: 999,
                  padding: "12px",
                  background:
                    ocr.status === "loading-lib" || ocr.status === "recognizing"
                      ? "#BFD8EF"
                      : `linear-gradient(135deg, ${COLORS.sky} 0%, ${COLORS.skyDark} 100%)`,
                  color: "#fff",
                  fontFamily: "'Baloo 2', sans-serif",
                  fontWeight: 800,
                  cursor: ocr.status === "loading-lib" || ocr.status === "recognizing" ? "default" : "pointer",
                }}
              >
                {ocr.status === "loading-lib" && "Загружаю распознавание..."}
                {ocr.status === "recognizing" && `Распознаю... ${ocr.progress}%`}
                {(ocr.status === "idle" || ocr.status === "done" || ocr.status === "error") && "🔍 Распознать текст с фото"}
              </button>

              <div style={{ fontSize: 12, color: "#B0BAC9", fontStyle: "italic" }}>
                Или впиши/поправь слова сам — формат: Отбасы — семья
              </div>
              <textarea
                value={quickText}
                onChange={(e) => setQuickText(e.target.value)}
                placeholder="Впиши сюда слова, по одному на строку..."
                rows={5}
                style={{ ...inputStyle, fontFamily: "'Nunito', sans-serif", resize: "vertical" }}
              />
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  onClick={handleQuickAdd}
                  style={{
                    flex: 1,
                    border: "none",
                    borderRadius: 999,
                    padding: "12px",
                    background: `linear-gradient(135deg, ${COLORS.steppe} 0%, #1E9E6C 100%)`,
                    color: "#fff",
                    fontFamily: "'Baloo 2', sans-serif",
                    fontWeight: 800,
                    cursor: "pointer",
                  }}
                >
                  Добавить в базу
                </button>
                <button
                  onClick={handleDiscardPhoto}
                  style={{
                    border: `2px solid #E1E8F5`,
                    borderRadius: 999,
                    padding: "12px 16px",
                    background: "#fff",
                    color: COLORS.ink,
                    fontFamily: "'Baloo 2', sans-serif",
                    fontWeight: 700,
                    cursor: "pointer",
                  }}
                  title="Удалить фото, ничего не сохраняя"
                >
                  Готово, удалить фото
                </button>
              </div>
            </>
          )}
        </div>

        {status && (
          <div
            style={{
              color: status.type === "ok" ? COLORS.steppe : COLORS.coral,
              fontWeight: 700,
              fontSize: 13,
              textAlign: "center",
            }}
          >
            {status.text}
          </div>
        )}

        {/* Flat word list — new words and words with mistakes float to the top */}
        {sortedWords.length === 0 && (
          <div style={{ textAlign: "center", color: "#B0BAC9", fontSize: 13, padding: "12px 0" }}>
            Слов пока нет — добавь первое выше 👆
          </div>
        )}
        {sortedWords.length > 0 && (
          <>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button
                onClick={toggleSelectMode}
                style={{
                  border: "none",
                  background: "transparent",
                  color: selectMode ? COLORS.coral : COLORS.skyDark,
                  fontWeight: 700,
                  fontSize: 13,
                  cursor: "pointer",
                }}
              >
                {selectMode ? "Отменить выбор" : "Выбрать несколько"}
              </button>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {sortedWords.map((w) => {
                const tested = isWordTested(w);
                const isNew = !tested;
                const level = (w.stats?.intervalIndex ?? -1) + 1; // 1..5, 0 if never reviewed
                const isDue = tested && w.stats?.nextReviewDate && w.stats.nextReviewDate <= new Date().toISOString();
                const isEditing = editingId === w.id;
                const isChecked = selectedIds.has(w.id);

                if (isEditing) {
                  return (
                    <div
                      key={w.id}
                      style={{
                        background: "#fff",
                        border: `2px solid ${COLORS.sky}`,
                        borderRadius: 12,
                        padding: "10px 14px",
                        display: "flex",
                        flexDirection: "column",
                        gap: 8,
                      }}
                    >
                      <input
                        value={editDraft.kz}
                        onChange={(e) => setEditDraft((d) => ({ ...d, kz: e.target.value }))}
                        placeholder="Казахское слово"
                        style={{ ...inputStyle, padding: "8px 12px", fontSize: 14 }}
                      />
                      <input
                        value={editDraft.ru}
                        onChange={(e) => setEditDraft((d) => ({ ...d, ru: e.target.value }))}
                        placeholder="Перевод"
                        style={{ ...inputStyle, padding: "8px 12px", fontSize: 14 }}
                      />
                      <div style={{ display: "flex", gap: 8 }}>
                        <button
                          onClick={() => saveEdit(w.id)}
                          style={{
                            flex: 1,
                            border: "none",
                            borderRadius: 8,
                            padding: "8px",
                            background: COLORS.steppe,
                            color: "#fff",
                            fontWeight: 700,
                            cursor: "pointer",
                          }}
                        >
                          Сохранить
                        </button>
                        <button
                          onClick={cancelEdit}
                          style={{
                            flex: 1,
                            border: `2px solid #E1E8F5`,
                            borderRadius: 8,
                            padding: "8px",
                            background: "#fff",
                            color: COLORS.ink,
                            fontWeight: 700,
                            cursor: "pointer",
                          }}
                        >
                          Отмена
                        </button>
                      </div>
                    </div>
                  );
                }

                return (
                  <div
                    key={w.id}
                    data-select-row={w.id}
                    onPointerDown={() => handleRowPointerDown(w.id)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      background: isChecked ? "#EAF3FF" : "#fff",
                      border: isChecked ? `1px solid ${COLORS.sky}` : "1px solid #EEF2F8",
                      borderRadius: 12,
                      padding: "10px 14px",
                      gap: 10,
                      cursor: selectMode ? "pointer" : "default",
                      touchAction: selectMode ? "none" : "auto",
                      userSelect: "none",
                    }}
                  >
                    {selectMode && (
                      <input
                        type="checkbox"
                        checked={isChecked}
                        readOnly
                        style={{ width: 18, height: 18, flexShrink: 0, pointerEvents: "none" }}
                      />
                    )}
                    <div style={{ fontSize: 14, color: COLORS.ink, flex: 1 }}>
                      <b>{w.kz}</b> — {w.ru}
                    </div>
                    {isNew && (
                      <span
                        style={{
                          fontSize: 10,
                          fontWeight: 800,
                          color: COLORS.skyDark,
                          background: "#E8F3FF",
                          borderRadius: 999,
                          padding: "3px 8px",
                          whiteSpace: "nowrap",
                        }}
                      >
                        новое
                      </span>
                    )}
                    {!isNew && isDue && (
                      <span
                        style={{
                          fontSize: 10,
                          fontWeight: 800,
                          color: "#B5471A",
                          background: "#FFEDE8",
                          borderRadius: 999,
                          padding: "3px 8px",
                          whiteSpace: "nowrap",
                        }}
                      >
                        к повторению
                      </span>
                    )}
                    {!isNew && !isDue && (
                      <span
                        style={{
                          fontSize: 10,
                          fontWeight: 800,
                          color: COLORS.steppe,
                          background: "#E4FBF0",
                          borderRadius: 999,
                          padding: "3px 8px",
                          whiteSpace: "nowrap",
                        }}
                        title={w.stats?.nextReviewDate ? `Следующий показ: ${new Date(w.stats.nextReviewDate).toLocaleDateString("ru-RU")}` : ""}
                      >
                        уровень {level}/5
                      </span>
                    )}
                    {!selectMode && (
                      <>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            startEdit(w);
                          }}
                          style={{
                            border: "none",
                            background: "transparent",
                            color: COLORS.skyDark,
                            cursor: "pointer",
                            fontSize: 14,
                          }}
                          title="Изменить слово"
                        >
                          ✏️
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDelete(w.id);
                          }}
                          style={{
                            border: "none",
                            background: "transparent",
                            color: COLORS.coral,
                            cursor: "pointer",
                            fontSize: 16,
                          }}
                          title="Удалить слово"
                        >
                          🗑
                        </button>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>

      {selectMode && (
        <div style={{ padding: "0 24px 24px", display: "flex", gap: 10 }}>
          <button
            onClick={handleDeleteSelected}
            disabled={selectedIds.size === 0}
            style={{
              flex: 1,
              border: "none",
              borderRadius: 999,
              padding: "14px",
              background: selectedIds.size === 0 ? "#D8DEE8" : COLORS.coral,
              color: "#fff",
              fontFamily: "'Baloo 2', sans-serif",
              fontWeight: 800,
              cursor: selectedIds.size === 0 ? "default" : "pointer",
            }}
          >
            Удалить выбранное ({selectedIds.size})
          </button>
        </div>
      )}
    </div>
  );
}

const inputStyle = {
  width: "100%",
  boxSizing: "border-box",
  padding: "12px 16px",
  borderRadius: 12,
  border: "2px solid #E1E8F5",
  fontSize: 15,
  fontFamily: "'Nunito', sans-serif",
  fontWeight: 600,
  color: "#16213D",
  outline: "none",
};

function HomeScreen({
  profile,
  avatar,
  onSwitchProfile,
  onUpdateName,
  onOpenWords,
  onStartNew,
  onStartReview,
  onStartPractice,
  onOpenWordBuilder,
  onOpenFillBlank,
  onOpenBoss,
  onOpenParent,
  wordCount,
  newWordsCount,
  dueReviewCount,
  hasStudiedWords,
}) {
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(profile.name);

  const saveName = () => {
    if (nameDraft.trim().length >= 2) {
      onUpdateName(nameDraft);
      setEditingName(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div
        style={{
          background: `linear-gradient(135deg, ${COLORS.sky} 0%, ${COLORS.skyDark} 100%)`,
          padding: "32px 24px 24px",
          color: "#fff",
          display: "flex",
          alignItems: "center",
          gap: 14,
        }}
      >
        <div
          style={{
            width: 58,
            height: 58,
            borderRadius: "50%",
            background: "rgba(255,255,255,0.18)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 30,
            border: `3px solid ${COLORS.sun}`,
          }}
        >
          {avatar?.emoji}
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, opacity: 0.85 }}>Привет,</div>
          {editingName ? (
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <input
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && saveName()}
                autoFocus
                maxLength={20}
                style={{
                  fontFamily: "'Baloo 2', sans-serif",
                  fontWeight: 800,
                  fontSize: 18,
                  padding: "4px 10px",
                  borderRadius: 10,
                  border: "none",
                  outline: "none",
                  color: COLORS.ink,
                  width: 130,
                }}
              />
              <button
                onClick={saveName}
                style={{
                  border: "none",
                  background: "rgba(255,255,255,0.25)",
                  color: "#fff",
                  borderRadius: 8,
                  padding: "4px 10px",
                  fontWeight: 700,
                  cursor: "pointer",
                }}
              >
                ✓
              </button>
            </div>
          ) : (
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ fontFamily: "'Baloo 2', sans-serif", fontWeight: 800, fontSize: 20 }}>
                {profile.name}!
              </div>
              <button
                onClick={() => {
                  setNameDraft(profile.name);
                  setEditingName(true);
                }}
                title="Изменить имя"
                style={{
                  border: "none",
                  background: "rgba(255,255,255,0.2)",
                  color: "#fff",
                  borderRadius: "50%",
                  width: 26,
                  height: 26,
                  fontSize: 12,
                  cursor: "pointer",
                }}
              >
                ✏️
              </button>
            </div>
          )}
        </div>
      </div>
      <OrnamentStrip color={COLORS.sun} />

      <div
        style={{
          flex: 1,
          padding: 24,
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
      >
        <div
          style={{
            background: COLORS.cloud,
            borderRadius: 18,
            padding: 18,
            display: "flex",
            alignItems: "center",
            gap: 12,
          }}
        >
          <div style={{ fontSize: 22 }}>🥉</div>
          <div>
            <div style={{ fontFamily: "'Baloo 2', sans-serif", fontWeight: 700, color: COLORS.ink }}>
              Бастаушы
            </div>
            <div style={{ fontSize: 12, color: "#7A8AA6" }}>Твоё текущее звание</div>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <button
            onClick={onStartNew}
            disabled={newWordsCount === 0}
            style={{
              background: newWordsCount === 0 ? "#EDEFF3" : `linear-gradient(135deg, ${COLORS.sun} 0%, #FFB020 100%)`,
              border: "none",
              borderRadius: 18,
              padding: "16px 14px",
              display: "flex",
              flexDirection: "column",
              gap: 4,
              cursor: newWordsCount === 0 ? "default" : "pointer",
              textAlign: "left",
              color: COLORS.ink,
            }}
          >
            <div style={{ fontSize: 22 }}>🆕</div>
            <div style={{ fontFamily: "'Baloo 2', sans-serif", fontWeight: 800, fontSize: 14 }}>Новые слова</div>
            <div style={{ fontSize: 12, opacity: 0.75 }}>
              {newWordsCount === 0 ? "нет новых" : `${newWordsCount} ждут изучения`}
            </div>
          </button>

          <button
            onClick={onStartReview}
            disabled={dueReviewCount === 0}
            style={{
              background: dueReviewCount === 0 ? "#EDEFF3" : `linear-gradient(135deg, ${COLORS.sky} 0%, ${COLORS.skyDark} 100%)`,
              border: "none",
              borderRadius: 18,
              padding: "16px 14px",
              display: "flex",
              flexDirection: "column",
              gap: 4,
              cursor: dueReviewCount === 0 ? "default" : "pointer",
              textAlign: "left",
              color: dueReviewCount === 0 ? COLORS.ink : "#fff",
            }}
          >
            <div style={{ fontSize: 22 }}>📅</div>
            <div style={{ fontFamily: "'Baloo 2', sans-serif", fontWeight: 800, fontSize: 14 }}>Повторение</div>
            <div style={{ fontSize: 12, opacity: 0.85 }}>
              {dueReviewCount === 0 ? "на сегодня пусто" : `${dueReviewCount} к повторению сегодня`}
            </div>
          </button>
        </div>

        <button
          onClick={onStartPractice}
          disabled={!hasStudiedWords}
          style={{
            background: "#fff",
            border: `2px solid ${hasStudiedWords ? COLORS.lilac : "#E1E8F5"}`,
            borderRadius: 16,
            padding: "12px 16px",
            display: "flex",
            alignItems: "center",
            gap: 10,
            cursor: hasStudiedWords ? "pointer" : "default",
            textAlign: "left",
          }}
        >
          <div style={{ fontSize: 18 }}>🔁</div>
          <div style={{ fontFamily: "'Baloo 2', sans-serif", fontWeight: 700, fontSize: 13, color: hasStudiedWords ? COLORS.ink : "#B0BAC9" }}>
            Повторить с начала — все пройденные слова, без расписания
          </div>
        </button>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <GameTile emoji="🧩" label="Собери слово" onClick={onOpenWordBuilder} disabled={wordCount < 4} color={COLORS.lilac} />
          <GameTile emoji="✍️" label="Заполни пропуск" onClick={onOpenFillBlank} disabled={wordCount < 4} color={COLORS.pink} />
          <GameTile emoji="⏱️" label="Босс-уровень" onClick={onOpenBoss} disabled={!hasStudiedWords} color={COLORS.coral} full />
        </div>

        <button
          onClick={onOpenWords}
          style={{
            background: `linear-gradient(135deg, ${COLORS.steppe} 0%, #22B37B 100%)`,
            border: "none",
            borderRadius: 18,
            padding: 18,
            display: "flex",
            alignItems: "center",
            gap: 12,
            cursor: "pointer",
            textAlign: "left",
            color: "#fff",
          }}
        >
          <div style={{ fontSize: 26 }}>📚</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: "'Baloo 2', sans-serif", fontWeight: 700, fontSize: 15 }}>
              База слов
            </div>
            <div style={{ fontSize: 12, opacity: 0.9 }}>
              {wordCount > 0 ? `Слов в базе: ${wordCount}` : "Пока пусто — добавь первые слова"}
            </div>
          </div>
          <div style={{ fontSize: 18, opacity: 0.9 }}>→</div>
        </button>
      </div>

      <div style={{ padding: "0 24px 32px", display: "flex", flexDirection: "column", gap: 10 }}>
        <button
          onClick={onOpenParent}
          style={{
            width: "100%",
            padding: "12px",
            borderRadius: 999,
            border: "none",
            background: "transparent",
            color: COLORS.skyDark,
            fontFamily: "'Baloo 2', sans-serif",
            fontWeight: 700,
            fontSize: 14,
            cursor: "pointer",
          }}
        >
          👨‍👩‍👧 Для родителей: прогресс
        </button>
        <button
          onClick={onSwitchProfile}
          style={{
            width: "100%",
            padding: "14px",
            borderRadius: 999,
            border: `2px solid #E1E8F5`,
            background: "#fff",
            color: COLORS.ink,
            fontFamily: "'Baloo 2', sans-serif",
            fontWeight: 700,
            fontSize: 15,
            cursor: "pointer",
          }}
        >
          Сменить спутника
        </button>
      </div>
    </div>
  );
}

function GameTile({ emoji, label, onClick, disabled, color, full }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        gridColumn: full ? "1 / -1" : "auto",
        background: disabled ? "#EDEFF3" : `${color}1A`,
        border: `2px solid ${disabled ? "#E1E8F5" : color}`,
        borderRadius: 16,
        padding: "14px 12px",
        display: "flex",
        alignItems: "center",
        gap: 10,
        cursor: disabled ? "default" : "pointer",
        textAlign: "left",
      }}
    >
      <div style={{ fontSize: 22 }}>{emoji}</div>
      <div style={{ fontFamily: "'Baloo 2', sans-serif", fontWeight: 700, fontSize: 13, color: disabled ? "#B0BAC9" : COLORS.ink }}>
        {label}
      </div>
    </button>
  );
}

// ---------- Learning session: flashcards, then a 4-option quiz ----------
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Builds up to 4 answer options for a word: its correct translation plus
// distinct wrong translations pulled from the rest of the word bank.
function buildQuizOptions(word, allWords) {
  const pool = allWords.filter((w) => w.id !== word.id && w.ru.trim().toLowerCase() !== word.ru.trim().toLowerCase());
  const wrongChoices = shuffle(pool).slice(0, 3).map((w) => w.ru);
  return shuffle([word.ru, ...wrongChoices]);
}

function LearnSession({ words, mode = "new", onRecordResult, onFinish }) {
  const [queue, setQueue] = useState(() => {
    if (mode === "review") return getDueReviewQueue(words, 10);
    if (mode === "practice") return getPracticeQueue(words, 10);
    return getNewWordsQueue(words, 10);
  });
  const [phase, setPhase] = useState("cards"); // cards | quiz | summary
  const [index, setIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [quizOptions, setQuizOptions] = useState(null);
  const [selectedOption, setSelectedOption] = useState(null);
  const [feedback, setFeedback] = useState(null); // 'correct' | 'wrong'
  const [coins, setCoins] = useState(0);
  const [correctCount, setCorrectCount] = useState(0);
  const [wrongCount, setWrongCount] = useState(0);

  const startPractice = () => {
    setQueue(getPracticeQueue(words, 10));
    setIndex(0);
    setPhase("cards");
    setFlipped(false);
  };

  if (queue.length === 0) {
    const emptyMessages = {
      new: "Новых слов пока нет — все, что есть в базе, уже изучаются",
      review: "На сегодня повторять нечего — приходи позже, когда что-то подойдёт по расписанию",
      practice: "В базе пока нет ни одного изученного слова",
    };
    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100%", alignItems: "center", justifyContent: "center", padding: 24, gap: 16, textAlign: "center" }}>
        <div style={{ fontSize: 40 }}>{mode === "review" ? "📅" : "🤔"}</div>
        <div style={{ fontFamily: "'Baloo 2', sans-serif", fontWeight: 700, color: COLORS.ink }}>
          {emptyMessages[mode]}
        </div>
        {mode !== "practice" && words.some(isWordTested) && (
          <button onClick={startPractice} style={primaryBtnStyle}>
            🔁 Повторить пройденное
          </button>
        )}
        <button onClick={onFinish} style={{ border: "none", background: "transparent", color: "#7A8AA6", fontWeight: 700, cursor: "pointer" }}>
          Вернуться в меню
        </button>
      </div>
    );
  }

  const currentWord = queue[index];

  const goToQuizPhase = () => {
    setPhase("quiz");
    setIndex(0);
    setQuizOptions(buildQuizOptions(queue[0], words));
    setSelectedOption(null);
    setFeedback(null);
  };

  const handleFlashcardNext = () => {
    if (index + 1 < queue.length) {
      setIndex(index + 1);
      setFlipped(false);
    } else {
      goToQuizPhase();
    }
  };

  const handleAnswer = (option) => {
    if (feedback) return; // already answered this one
    const isCorrect = option === currentWord.ru;
    setSelectedOption(option);
    setFeedback(isCorrect ? "correct" : "wrong");
    onRecordResult(currentWord.id, isCorrect);
    if (isCorrect) {
      setCoins((c) => c + 10);
      setCorrectCount((c) => c + 1);
    } else {
      setWrongCount((c) => c + 1);
    }
    setTimeout(() => {
      if (index + 1 < queue.length) {
        const nextIndex = index + 1;
        setIndex(nextIndex);
        setQuizOptions(buildQuizOptions(queue[nextIndex], words));
        setSelectedOption(null);
        setFeedback(null);
      } else {
        setPhase("summary");
      }
    }, 900);
  };

  if (phase === "summary") {
    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
        <div
          style={{
            background: `linear-gradient(135deg, ${COLORS.sun} 0%, #FFB020 100%)`,
            padding: "40px 24px",
            textAlign: "center",
            color: COLORS.ink,
          }}
        >
          <div style={{ fontSize: 48 }}>🏆</div>
          <div style={{ fontFamily: "'Baloo 2', sans-serif", fontWeight: 800, fontSize: 22, marginTop: 8 }}>
            Тест пройден!
          </div>
        </div>
        <div style={{ flex: 1, padding: 24, display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ display: "flex", gap: 12 }}>
            <StatCard label="Монеток" value={`🪙 ${coins}`} />
            <StatCard label="Верно" value={correctCount} color={COLORS.steppe} />
            <StatCard label="Ошибок" value={wrongCount} color={COLORS.coral} />
          </div>
        </div>
        <div style={{ padding: "0 24px 32px" }}>
          <button onClick={onFinish} style={primaryBtnStyle}>
            Вернуться в меню
          </button>
        </div>
      </div>
    );
  }

  if (phase === "quiz") {
    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
        <div
          style={{
            background: `linear-gradient(135deg, ${COLORS.sky} 0%, ${COLORS.skyDark} 100%)`,
            padding: "24px",
            color: "#fff",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <div style={{ fontSize: 13, opacity: 0.9 }}>Вопрос {index + 1} из {queue.length}</div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ fontFamily: "'Baloo 2', sans-serif", fontWeight: 800 }}>🪙 {coins}</div>
            <button onClick={onFinish} title="В меню" style={homeBtnStyle}>
              🏠
            </button>
          </div>
        </div>
        <div style={{ flex: 1, padding: 24, display: "flex", flexDirection: "column", gap: 20 }}>
          <div
            style={{
              background: COLORS.cloud,
              borderRadius: 20,
              padding: 28,
              textAlign: "center",
              fontFamily: "'Baloo 2', sans-serif",
              fontWeight: 800,
              fontSize: 28,
              color: COLORS.ink,
            }}
          >
            {currentWord.kz}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {quizOptions.map((opt) => {
              const isSelected = selectedOption === opt;
              const isCorrectOpt = opt === currentWord.ru;
              let bg = "#fff";
              let border = "2px solid #E1E8F5";
              if (feedback && isCorrectOpt) {
                bg = "#E4FBF0";
                border = `2px solid ${COLORS.steppe}`;
              } else if (feedback && isSelected && !isCorrectOpt) {
                bg = "#FFECE9";
                border = `2px solid ${COLORS.coral}`;
              }
              return (
                <button
                  key={opt}
                  onClick={() => handleAnswer(opt)}
                  disabled={!!feedback}
                  style={{
                    padding: "14px 16px",
                    borderRadius: 14,
                    border,
                    background: bg,
                    color: COLORS.ink,
                    fontSize: 16,
                    fontWeight: 700,
                    textAlign: "left",
                    cursor: feedback ? "default" : "pointer",
                  }}
                >
                  {opt}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    );
  }

  // Flashcard phase
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div
        style={{
          background: `linear-gradient(135deg, ${COLORS.lilac} 0%, #7C5FE0 100%)`,
          padding: "24px",
          color: "#fff",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
        }}
      >
        <div>
          <div style={{ fontSize: 13, opacity: 0.9 }}>Карточка {index + 1} из {queue.length}</div>
          <div style={{ fontFamily: "'Baloo 2', sans-serif", fontWeight: 800, fontSize: 18 }}>Изучаем слова</div>
        </div>
        <button onClick={onFinish} title="В меню" style={homeBtnStyle}>
          🏠
        </button>
      </div>
      <div style={{ flex: 1, padding: 24, display: "flex", flexDirection: "column", justifyContent: "center", gap: 24 }}>
        <div
          onClick={() => setFlipped((f) => !f)}
          style={{
            background: flipped ? COLORS.steppe : "#fff",
            border: `3px solid ${flipped ? COLORS.steppe : COLORS.lilac}`,
            borderRadius: 24,
            padding: "50px 24px",
            textAlign: "center",
            cursor: "pointer",
            minHeight: 140,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <div
            style={{
              fontFamily: "'Baloo 2', sans-serif",
              fontWeight: 800,
              fontSize: 30,
              color: flipped ? "#fff" : COLORS.ink,
            }}
          >
            {flipped ? currentWord.ru : currentWord.kz}
          </div>
        </div>
        <div style={{ textAlign: "center", fontSize: 13, color: "#B0BAC9" }}>
          {flipped ? "Это перевод — жми «Дальше»" : "Нажми на карточку, чтобы увидеть перевод"}
        </div>
      </div>
      <div style={{ padding: "0 24px 32px" }}>
        <button onClick={handleFlashcardNext} style={primaryBtnStyle}>
          {index + 1 < queue.length ? "Дальше →" : "Перейти к тесту →"}
        </button>
      </div>
    </div>
  );
}

function StatCard({ label, value, color = COLORS.ink }) {
  return (
    <div style={{ flex: 1, background: COLORS.cloud, borderRadius: 16, padding: 14, textAlign: "center" }}>
      <div style={{ fontFamily: "'Baloo 2', sans-serif", fontWeight: 800, fontSize: 20, color }}>{value}</div>
      <div style={{ fontSize: 11, color: "#7A8AA6", marginTop: 2 }}>{label}</div>
    </div>
  );
}

const homeBtnStyle = {
  border: "none",
  background: "rgba(255,255,255,0.22)",
  color: "#fff",
  borderRadius: "50%",
  width: 34,
  height: 34,
  fontSize: 16,
  cursor: "pointer",
};

const primaryBtnStyle = {
  width: "100%",
  padding: "16px",
  borderRadius: 999,
  border: "none",
  background: `linear-gradient(135deg, ${COLORS.sun} 0%, #FFB020 100%)`,
  color: COLORS.ink,
  fontFamily: "'Baloo 2', sans-serif",
  fontWeight: 800,
  fontSize: 16,
  cursor: "pointer",
  boxShadow: "0 8px 20px rgba(255,197,61,0.4)",
};

// ---------- Parent dashboard ----------
function ParentDashboard({ words, profile, onBack }) {
  const total = words.length;
  const studied = words.filter((w) => (w.stats?.correct || 0) + (w.stats?.wrong || 0) > 0);
  const mastered = studied.filter((w) => (w.stats?.wrong || 0) === 0);
  const needsReview = studied.filter((w) => (w.stats?.wrong || 0) > 0);
  const untouched = total - studied.length;

  const totalCorrect = words.reduce((s, w) => s + (w.stats?.correct || 0), 0);
  const totalWrong = words.reduce((s, w) => s + (w.stats?.wrong || 0), 0);
  const totalAnswers = totalCorrect + totalWrong;
  const accuracy = totalAnswers > 0 ? Math.round((totalCorrect / totalAnswers) * 100) : null;

  const trickiest = getRepeatedlyTestedWords(words, 1).slice(0, 5);

  const lastActivity = words
    .map((w) => w.stats?.lastTestedAt)
    .filter(Boolean)
    .sort()
    .slice(-1)[0];

  const formatDate = (iso) => {
    if (!iso) return "ещё не было";
    const d = new Date(iso);
    return d.toLocaleDateString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  };

  const Bar = ({ label, value, max, color }) => (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#7A8AA6", marginBottom: 4 }}>
        <span>{label}</span>
        <span>{value}</span>
      </div>
      <div style={{ background: "#EEF2F8", borderRadius: 999, height: 10, overflow: "hidden" }}>
        <div style={{ width: max > 0 ? `${Math.min(100, Math.round((value / max) * 100))}%` : "0%", height: "100%", background: color }} />
      </div>
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ background: `linear-gradient(135deg, ${COLORS.sky} 0%, ${COLORS.skyDark} 100%)`, padding: "28px 24px 20px", color: "#fff", display: "flex", alignItems: "center", gap: 12 }}>
        <button onClick={onBack} style={{ border: "none", background: "rgba(255,255,255,0.2)", color: "#fff", borderRadius: "50%", width: 36, height: 36, fontSize: 16, cursor: "pointer" }}>
          ←
        </button>
        <div>
          <div style={{ fontFamily: "'Baloo 2', sans-serif", fontWeight: 800, fontSize: 20 }}>Прогресс {profile?.name}</div>
          <div style={{ fontSize: 12, opacity: 0.9 }}>Последняя активность: {formatDate(lastActivity)}</div>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: 24, display: "flex", flexDirection: "column", gap: 20 }}>
        <div style={{ display: "flex", gap: 12 }}>
          <StatCard label="Слов в базе" value={total} />
          <StatCard label="Изучено" value={studied.length} color={COLORS.sky} />
          <StatCard label="Точность" value={accuracy === null ? "—" : `${accuracy}%`} color={accuracy !== null && accuracy >= 70 ? COLORS.steppe : COLORS.coral} />
        </div>

        <div style={{ background: COLORS.cloud, borderRadius: 18, padding: 18, display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ fontFamily: "'Baloo 2', sans-serif", fontWeight: 700, fontSize: 14, color: COLORS.ink }}>
            Как распределены слова
          </div>
          <Bar label="🏆 Усвоено полностью" value={mastered.length} max={total || 1} color={COLORS.steppe} />
          <Bar label="⚠️ Нужно повторить (были ошибки)" value={needsReview.length} max={total || 1} color={COLORS.coral} />
          <Bar label="🆕 Ещё не изучались" value={untouched} max={total || 1} color={COLORS.sky} />
        </div>

        <div style={{ background: COLORS.cloud, borderRadius: 18, padding: 18, display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ fontFamily: "'Baloo 2', sans-serif", fontWeight: 700, fontSize: 14, color: COLORS.ink }}>
            Всего ответов: {totalAnswers}
          </div>
          <div style={{ display: "flex", gap: 16, fontSize: 13, color: "#7A8AA6" }}>
            <span>✅ Верно: <b style={{ color: COLORS.steppe }}>{totalCorrect}</b></span>
            <span>❌ Неверно: <b style={{ color: COLORS.coral }}>{totalWrong}</b></span>
          </div>
        </div>

        <div>
          <div style={{ fontFamily: "'Baloo 2', sans-serif", fontWeight: 700, fontSize: 14, color: COLORS.ink, marginBottom: 10 }}>
            Слова, которые даются сложнее всего
          </div>
          {trickiest.length === 0 && (
            <div style={{ fontSize: 13, color: "#B0BAC9", textAlign: "center", padding: "12px 0" }}>
              Пока данных недостаточно — начните обучение
            </div>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {trickiest.map((w) => (
              <div key={w.id} style={{ display: "flex", justifyContent: "space-between", background: "#fff", border: "1px solid #EEF2F8", borderRadius: 12, padding: "10px 14px", fontSize: 14 }}>
                <span><b>{w.kz}</b> — {w.ru}</span>
                <span style={{ color: COLORS.coral, fontWeight: 700 }}>ошибок: {w.stats.wrong}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
const BOSS_SECONDS_PER_WORD = 12;

function BossLevel({ words, onRecordResult, onFinish }) {
  const [queue] = useState(() => getBossLevelQueue(words));
  const [index, setIndex] = useState(0);
  const [options, setOptions] = useState(() => (queue[0] ? buildQuizOptions(queue[0], words) : []));
  const [selected, setSelected] = useState(null);
  const [feedback, setFeedback] = useState(null);
  const [coins, setCoins] = useState(0);
  const [correctCount, setCorrectCount] = useState(0);
  const [wrongCount, setWrongCount] = useState(0);
  const [phase, setPhase] = useState("intro"); // intro | playing | summary
  const [timeLeft, setTimeLeft] = useState(queue.length * BOSS_SECONDS_PER_WORD);
  const timerRef = useRef(null);

  useEffect(() => {
    if (phase !== "playing") return;
    timerRef.current = setInterval(() => {
      setTimeLeft((t) => {
        if (t <= 1) {
          clearInterval(timerRef.current);
          setPhase("summary");
          return 0;
        }
        return t - 1;
      });
    }, 1000);
    return () => clearInterval(timerRef.current);
  }, [phase]);

  if (queue.length === 0) {
    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100%", alignItems: "center", justifyContent: "center", padding: 24, gap: 16, textAlign: "center" }}>
        <div style={{ fontSize: 40 }}>⏱️</div>
        <div style={{ fontFamily: "'Baloo 2', sans-serif", fontWeight: 700, color: COLORS.ink }}>
          Босс-уровень откроется, когда пройдёшь обычное обучение хотя бы раз
        </div>
        <button onClick={onFinish} style={primaryBtnStyle}>Вернуться в меню</button>
      </div>
    );
  }

  const currentWord = queue[index];

  const handleAnswer = (option) => {
    if (feedback) return;
    const isCorrect = option === currentWord.ru;
    setSelected(option);
    setFeedback(isCorrect ? "correct" : "wrong");
    onRecordResult(currentWord.id, isCorrect);
    if (isCorrect) {
      setCoins((c) => c + 10);
      setCorrectCount((c) => c + 1);
    } else {
      setWrongCount((c) => c + 1);
    }
    setTimeout(() => {
      if (index + 1 < queue.length) {
        const nextIndex = index + 1;
        setIndex(nextIndex);
        setOptions(buildQuizOptions(queue[nextIndex], words));
        setSelected(null);
        setFeedback(null);
      } else {
        setPhase("summary");
      }
    }, 700);
  };

  if (phase === "intro") {
    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100%", alignItems: "center", justifyContent: "center", padding: 24, gap: 20, textAlign: "center" }}>
        <div style={{ fontSize: 56 }}>👑</div>
        <div style={{ fontFamily: "'Baloo 2', sans-serif", fontWeight: 800, fontSize: 22, color: COLORS.ink }}>
          Босс-уровень
        </div>
        <div style={{ color: "#7A8AA6", fontSize: 14, lineHeight: 1.6 }}>
          Здесь — все {queue.length} слов, которые ты уже проходил(а), одно за другим.
          <br />
          Время ограничено: {Math.round((queue.length * BOSS_SECONDS_PER_WORD) / 60 * 10) / 10} мин на всё.
        </div>
        <button
          onClick={() => setPhase("playing")}
          style={{ ...primaryBtnStyle, background: `linear-gradient(135deg, ${COLORS.coral} 0%, #E2483A 100%)`, boxShadow: "0 8px 20px rgba(255,107,94,0.4)" }}
        >
          Начать! 🚀
        </button>
        <button onClick={onFinish} style={{ border: "none", background: "transparent", color: "#7A8AA6", fontWeight: 700, cursor: "pointer" }}>
          Не сейчас
        </button>
      </div>
    );
  }

  if (phase === "summary") {
    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
        <div style={{ background: `linear-gradient(135deg, ${COLORS.coral} 0%, #E2483A 100%)`, padding: "40px 24px", textAlign: "center", color: "#fff" }}>
          <div style={{ fontSize: 48 }}>👑</div>
          <div style={{ fontFamily: "'Baloo 2', sans-serif", fontWeight: 800, fontSize: 22, marginTop: 8 }}>
            Босс-уровень пройден!
          </div>
        </div>
        <div style={{ flex: 1, padding: 24, display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ display: "flex", gap: 12 }}>
            <StatCard label="Монеток" value={`🪙 ${coins}`} />
            <StatCard label="Верно" value={correctCount} color={COLORS.steppe} />
            <StatCard label="Ошибок" value={wrongCount} color={COLORS.coral} />
          </div>
        </div>
        <div style={{ padding: "0 24px 32px" }}>
          <button onClick={onFinish} style={primaryBtnStyle}>Вернуться в меню</button>
        </div>
      </div>
    );
  }

  const timePercent = Math.max(0, Math.round((timeLeft / (queue.length * BOSS_SECONDS_PER_WORD)) * 100));

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ background: `linear-gradient(135deg, ${COLORS.coral} 0%, #E2483A 100%)`, padding: "20px 24px", color: "#fff" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <div style={{ fontSize: 13, opacity: 0.9 }}>Вопрос {index + 1} из {queue.length}</div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ fontFamily: "'Baloo 2', sans-serif", fontWeight: 800 }}>🪙 {coins}</div>
            <button onClick={onFinish} title="В меню" style={homeBtnStyle}>🏠</button>
          </div>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4 }}>
          <span>⏱ {timeLeft}с</span>
        </div>
        <div style={{ background: "rgba(255,255,255,0.25)", borderRadius: 999, height: 8, overflow: "hidden" }}>
          <div style={{ width: `${timePercent}%`, height: "100%", background: "#fff", transition: "width 1s linear" }} />
        </div>
      </div>
      <div style={{ flex: 1, padding: 24, display: "flex", flexDirection: "column", gap: 20 }}>
        <div style={{ background: COLORS.cloud, borderRadius: 20, padding: 28, textAlign: "center", fontFamily: "'Baloo 2', sans-serif", fontWeight: 800, fontSize: 28, color: COLORS.ink }}>
          {currentWord.kz}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {options.map((opt) => {
            const isSelected = selected === opt;
            const isCorrectOpt = opt === currentWord.ru;
            let bg = "#fff";
            let border = "2px solid #E1E8F5";
            if (feedback && isCorrectOpt) {
              bg = "#E4FBF0";
              border = `2px solid ${COLORS.steppe}`;
            } else if (feedback && isSelected && !isCorrectOpt) {
              bg = "#FFECE9";
              border = `2px solid ${COLORS.coral}`;
            }
            return (
              <button
                key={opt}
                onClick={() => handleAnswer(opt)}
                disabled={!!feedback}
                style={{ padding: "14px 16px", borderRadius: 14, border, background: bg, color: COLORS.ink, fontSize: 16, fontWeight: 700, textAlign: "left", cursor: feedback ? "default" : "pointer" }}
              >
                {opt}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
const FILL_BLANK_TEMPLATES = [
  {
    kk: (kz) => `Бұл — үлкен ${kz}.`,
    ru: (ru) => (
      <>
        Это что-то большое: <b>{ru}</b>.
      </>
    ),
  },
  {
    kk: (kz) => `Мен ${kz} туралы білемін.`,
    ru: (ru) => (
      <>
        Я знаю про <b>{ru}</b>.
      </>
    ),
  },
];

function FillBlankGame({ words, onRecordResult, onFinish }) {
  const [queue, setQueue] = useState(() => getMixedQueue(words, 10));
  const [index, setIndex] = useState(0);
  const [template, setTemplate] = useState(() => queue.map(() => FILL_BLANK_TEMPLATES[Math.floor(Math.random() * FILL_BLANK_TEMPLATES.length)]));
  const [options, setOptions] = useState(() => (queue[0] ? buildQuizOptionsKz(queue[0], words) : []));
  const [selected, setSelected] = useState(null);
  const [feedback, setFeedback] = useState(null);
  const [coins, setCoins] = useState(0);

  const startPractice = () => {
    const practiceQueue = getPracticeQueue(words, 10);
    setQueue(practiceQueue);
    setTemplate(practiceQueue.map(() => FILL_BLANK_TEMPLATES[Math.floor(Math.random() * FILL_BLANK_TEMPLATES.length)]));
    setOptions(practiceQueue[0] ? buildQuizOptionsKz(practiceQueue[0], words) : []);
    setIndex(0);
    setSelected(null);
    setFeedback(null);
  };

  if (queue.length === 0) {
    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100%", alignItems: "center", justifyContent: "center", padding: 24, gap: 16, textAlign: "center" }}>
        <div style={{ fontSize: 40 }}>✍️</div>
        <div style={{ fontFamily: "'Baloo 2', sans-serif", fontWeight: 700, color: COLORS.ink }}>
          {words.length === 0 ? "Пока нет слов для этого задания" : "Все слова уже выучены без единой ошибки!"}
        </div>
        {words.length > 0 && (
          <button onClick={startPractice} style={primaryBtnStyle}>
            🔁 Повторить пройденное
          </button>
        )}
        <button onClick={onFinish} style={{ border: "none", background: "transparent", color: "#7A8AA6", fontWeight: 700, cursor: "pointer" }}>
          Вернуться в меню
        </button>
      </div>
    );
  }


  const currentWord = queue[index];
  const currentTemplate = template[index];

  const handleAnswer = (option) => {
    if (feedback) return;
    const isCorrect = option === currentWord.kz;
    setSelected(option);
    setFeedback(isCorrect ? "correct" : "wrong");
    onRecordResult(currentWord.id, isCorrect);
    if (isCorrect) setCoins((c) => c + 10);
    setTimeout(() => {
      if (index + 1 < queue.length) {
        const nextIndex = index + 1;
        setIndex(nextIndex);
        setOptions(buildQuizOptionsKz(queue[nextIndex], words));
        setSelected(null);
        setFeedback(null);
      } else {
        onFinish();
      }
    }, 1100);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div
        style={{
          background: `linear-gradient(135deg, ${COLORS.pink} 0%, #D6407D 100%)`,
          padding: "24px",
          color: "#fff",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
        }}
      >
        <div>
          <div style={{ fontSize: 13, opacity: 0.9 }}>Вопрос {index + 1} из {queue.length}</div>
          <div style={{ fontFamily: "'Baloo 2', sans-serif", fontWeight: 800, fontSize: 18 }}>Заполни пропуск ✍️</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ fontFamily: "'Baloo 2', sans-serif", fontWeight: 800 }}>🪙 {coins}</div>
          <button onClick={onFinish} title="В меню" style={homeBtnStyle}>🏠</button>
        </div>
      </div>

      <div style={{ flex: 1, padding: 24, display: "flex", flexDirection: "column", gap: 20 }}>
        <div style={{ background: COLORS.cloud, borderRadius: 18, padding: 20, textAlign: "center" }}>
          <div style={{ fontSize: 12, color: "#7A8AA6", marginBottom: 8 }}>Прочитай и найди перевод:</div>
          <div style={{ fontSize: 17, color: COLORS.ink, lineHeight: 1.5 }}>{currentTemplate.ru(currentWord.ru)}</div>
        </div>

        <div style={{ textAlign: "center", fontFamily: "'Baloo 2', sans-serif", fontWeight: 700, color: "#7A8AA6", fontSize: 14 }}>
          {currentTemplate.kk("___")}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {options.map((opt) => {
            const isSelected = selected === opt;
            const isCorrectOpt = opt === currentWord.kz;
            let bg = "#fff";
            let border = "2px solid #E1E8F5";
            if (feedback && isCorrectOpt) {
              bg = "#E4FBF0";
              border = `2px solid ${COLORS.steppe}`;
            } else if (feedback && isSelected && !isCorrectOpt) {
              bg = "#FFECE9";
              border = `2px solid ${COLORS.coral}`;
            }
            return (
              <button
                key={opt}
                onClick={() => handleAnswer(opt)}
                disabled={!!feedback}
                style={{
                  padding: "14px 16px",
                  borderRadius: 14,
                  border,
                  background: bg,
                  color: COLORS.ink,
                  fontSize: 16,
                  fontWeight: 700,
                  textAlign: "left",
                  cursor: feedback ? "default" : "pointer",
                }}
              >
                {currentTemplate.kk(opt)}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// Same idea as buildQuizOptions but options are Kazakh words (used when the
// prompt is already in Russian, as in the fill-in-the-blank game).
function buildQuizOptionsKz(word, allWords) {
  const pool = allWords.filter((w) => w.id !== word.id && w.kz.trim().toLowerCase() !== word.kz.trim().toLowerCase());
  const wrongChoices = shuffle(pool).slice(0, 3).map((w) => w.kz);
  return shuffle([word.kz, ...wrongChoices]);
}
function makeLetterTiles(word) {
  const letters = [...word.toUpperCase()];
  const tiles = letters.map((ch, i) => ({ id: `${i}-${ch}`, ch }));
  return shuffle(tiles);
}

function WordBuilderGame({ words, onRecordResult, onFinish }) {
  // Only words with at least 2 letters make sense for this game.
  const eligibleWords = words.filter((w) => w.kz.trim().length >= 2);
  const [queue, setQueue] = useState(() => getMixedQueue(eligibleWords, 10));
  const [index, setIndex] = useState(0);
  const [tiles, setTiles] = useState(() => (queue[0] ? makeLetterTiles(queue[0].kz) : []));
  const [usedIds, setUsedIds] = useState([]); // ordered list of tile ids tapped so far
  const [feedback, setFeedback] = useState(null); // 'correct' | 'wrong' | null
  const [coins, setCoins] = useState(0);

  const currentWord = queue[index];

  const resetForWord = (word) => {
    setTiles(makeLetterTiles(word.kz));
    setUsedIds([]);
    setFeedback(null);
  };

  const startPractice = () => {
    const practiceQueue = getPracticeQueue(eligibleWords, 10);
    setQueue(practiceQueue);
    setIndex(0);
    if (practiceQueue[0]) resetForWord(practiceQueue[0]);
  };

  if (queue.length === 0) {
    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100%", alignItems: "center", justifyContent: "center", padding: 24, gap: 16, textAlign: "center" }}>
        <div style={{ fontSize: 40 }}>🧩</div>
        <div style={{ fontFamily: "'Baloo 2', sans-serif", fontWeight: 700, color: COLORS.ink }}>
          {eligibleWords.length === 0 ? "Пока нет подходящих слов для этой игры" : "Все слова уже выучены без единой ошибки!"}
        </div>
        {eligibleWords.length > 0 && (
          <button onClick={startPractice} style={primaryBtnStyle}>
            🔁 Повторить пройденное
          </button>
        )}
        <button onClick={onFinish} style={{ border: "none", background: "transparent", color: "#7A8AA6", fontWeight: 700, cursor: "pointer" }}>
          Вернуться в меню
        </button>
      </div>
    );
  }

  const typedWord = usedIds.map((id) => tiles.find((t) => t.id === id).ch).join("");

  const handleTapTile = (tileId) => {
    if (feedback || usedIds.includes(tileId)) return;
    const nextUsed = [...usedIds, tileId];
    setUsedIds(nextUsed);
    const attempt = nextUsed.map((id) => tiles.find((t) => t.id === id).ch).join("");
    if (attempt.length === currentWord.kz.length) {
      const isCorrect = attempt === currentWord.kz.toUpperCase();
      setFeedback(isCorrect ? "correct" : "wrong");
      onRecordResult(currentWord.id, isCorrect);
      if (isCorrect) setCoins((c) => c + 10);
      setTimeout(() => {
        if (index + 1 < queue.length) {
          const nextIndex = index + 1;
          setIndex(nextIndex);
          resetForWord(queue[nextIndex]);
        } else {
          onFinish();
        }
      }, isCorrect ? 900 : 1500);
    }
  };

  const handleBackspace = () => {
    if (feedback) return;
    setUsedIds((prev) => prev.slice(0, -1));
  };

  const KZ_EXTRA = ["Ә", "Ғ", "Қ", "Ң", "Ө", "Ұ", "Ү", "Һ"];

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div
        style={{
          background: `linear-gradient(135deg, ${COLORS.lilac} 0%, #7C5FE0 100%)`,
          padding: "24px",
          color: "#fff",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
        }}
      >
        <div>
          <div style={{ fontSize: 13, opacity: 0.9 }}>Слово {index + 1} из {queue.length}</div>
          <div style={{ fontFamily: "'Baloo 2', sans-serif", fontWeight: 800, fontSize: 18 }}>Собери слово 🧩</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ fontFamily: "'Baloo 2', sans-serif", fontWeight: 800 }}>🪙 {coins}</div>
          <button onClick={onFinish} title="В меню" style={homeBtnStyle}>🏠</button>
        </div>
      </div>

      <div style={{ flex: 1, padding: 24, display: "flex", flexDirection: "column", gap: 20 }}>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 12, color: "#7A8AA6", marginBottom: 4 }}>Переведи на казахский:</div>
          <div style={{ fontFamily: "'Baloo 2', sans-serif", fontWeight: 800, fontSize: 22, color: COLORS.ink }}>
            {currentWord.ru}
          </div>
        </div>

        {/* Answer slots */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, justifyContent: "center", minHeight: 48 }}>
          {[...currentWord.kz].map((_, i) => (
            <div
              key={i}
              style={{
                width: 34,
                height: 40,
                borderRadius: 8,
                border: `2px solid ${
                  feedback === "correct" ? COLORS.steppe : feedback === "wrong" ? COLORS.coral : "#D8DEE8"
                }`,
                background: i < typedWord.length ? (feedback === "wrong" ? "#FFECE9" : "#EAF3FF") : "#fff",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontFamily: "'Baloo 2', sans-serif",
                fontWeight: 800,
                fontSize: 18,
                color: COLORS.ink,
              }}
            >
              {typedWord[i] || ""}
            </div>
          ))}
        </div>

        {feedback === "wrong" && (
          <div style={{ textAlign: "center", color: COLORS.coral, fontWeight: 700, fontSize: 14 }}>
            Правильно: {currentWord.kz}
          </div>
        )}

        {/* Letter tiles */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "center" }}>
          {tiles.map((t) => {
            const used = usedIds.includes(t.id);
            return (
              <button
                key={t.id}
                onClick={() => handleTapTile(t.id)}
                disabled={used || !!feedback}
                style={{
                  width: 42,
                  height: 46,
                  borderRadius: 10,
                  border: "none",
                  background: used ? "#E1E8F5" : `linear-gradient(135deg, ${COLORS.sky} 0%, ${COLORS.skyDark} 100%)`,
                  color: used ? "#B0BAC9" : "#fff",
                  fontFamily: "'Baloo 2', sans-serif",
                  fontWeight: 800,
                  fontSize: 18,
                  cursor: used || feedback ? "default" : "pointer",
                }}
              >
                {t.ch}
              </button>
            );
          })}
        </div>

        {/* Reference row for special Kazakh letters, just for visual familiarity */}
        <div style={{ display: "flex", justifyContent: "center", gap: 4, opacity: 0.4 }}>
          {KZ_EXTRA.map((l) => (
            <span key={l} style={{ fontSize: 11, color: COLORS.ink }}>{l}</span>
          ))}
        </div>
      </div>

      <div style={{ padding: "0 24px 32px" }}>
        <button
          onClick={handleBackspace}
          disabled={!!feedback || usedIds.length === 0}
          style={{
            width: "100%",
            padding: "14px",
            borderRadius: 999,
            border: `2px solid #E1E8F5`,
            background: "#fff",
            color: COLORS.ink,
            fontFamily: "'Baloo 2', sans-serif",
            fontWeight: 700,
            cursor: usedIds.length === 0 ? "default" : "pointer",
          }}
        >
          ⌫ Стереть букву
        </button>
      </div>
    </div>
  );
}
