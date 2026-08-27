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
      // `history` keeps a full log of past attempts (capped) so we can tell
      // apart a word tested once from one that keeps coming back up.
      stats: { correct: 0, wrong: 0, lastResult: null, lastTestedAt: null, history: [] },
    });
  }
  return { merged: [...existing, ...added], added, skipped };
}

// Records the result of one test answer for a word (call this from the future
// test/game modules). Returns the updated words array — caller should save it.
const MAX_HISTORY_PER_WORD = 20;

function recordWordResult(words, wordId, isCorrect) {
  return words.map((w) => {
    if (w.id !== wordId) return w;
    const stats = w.stats || { correct: 0, wrong: 0, lastResult: null, lastTestedAt: null, history: [] };
    const now = new Date().toISOString();
    const history = [...(stats.history || []), { date: now, correct: isCorrect }].slice(
      -MAX_HISTORY_PER_WORD
    );
    return {
      ...w,
      stats: {
        correct: stats.correct + (isCorrect ? 1 : 0),
        wrong: stats.wrong + (isCorrect ? 0 : 1),
        lastResult: isCorrect ? "correct" : "wrong",
        lastTestedAt: now,
        history,
      },
    };
  });
}

// Words worth reviewing in a "Работа над ошибками" mode: anything ever
// answered wrong, ranked so the shakiest words come first.
function getWordsToReview(words) {
  return words
    .filter((w) => (w.stats?.wrong || 0) > 0)
    .sort((a, b) => {
      const aScore = (a.stats.wrong || 0) - (a.stats.correct || 0);
      const bScore = (b.stats.wrong || 0) - (b.stats.correct || 0);
      return bScore - aScore;
    });
}

// The main selection rule for flashcards/tests, in one place so every future
// screen (flashcards, "1 из 4", "Собери слово", boss level) uses the same logic:
//   1. New words (never tested) always come first — learn what's fresh.
//   2. Old words that were fully correct (mastered) are left alone — no need
//      to keep re-testing what the child already knows.
//   3. Old words with at least one mistake are pulled back in for review,
//      ordered by how shaky they are (more wrong answers = higher priority).
// `limit` caps the returned queue (e.g. 10, to match the "max 10 tasks per test" rule).
function getLearningQueue(words, limit = 10) {
  const isNew = (w) => (w.stats?.correct || 0) + (w.stats?.wrong || 0) === 0;
  const newWords = words.filter(isNew);
  const reviewWords = getWordsToReview(words.filter((w) => !isNew(w)));
  return [...newWords, ...reviewWords].slice(0, limit);
}

// "Боss level": a cumulative test over everything the child has already
// studied (words that have appeared in at least one test before) — brand-new,
// never-tested words are excluded since they haven't been "passed material" yet.
// Ordered sequentially by when each word was first added, so the test walks
// through the material in the same order it was learned.
function getBossLevelQueue(words) {
  const studied = words.filter((w) => (w.stats?.correct || 0) + (w.stats?.wrong || 0) > 0);
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

// Parses a CSV or JSON file's text content into raw {kz, ru} rows.
// A third "category" column, if present (old-format files), is simply ignored.
function parseWordFile(text, filename) {
  const isJson = filename.toLowerCase().endsWith(".json") || text.trim().startsWith("[");
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
  // CSV: expected columns kazakh,russian (a third column is ignored if present).
  // Wrap a field in double quotes if it contains a comma, e.g. "значение, важность".
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    const parts = splitCsvLine(lines[i]);
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
              onStartLearning={() => goTo("learn")}
              wordCount={words.length}
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
              onRecordResult={(wordId, isCorrect) => {
                const updated = recordWordResult(words, wordId, isCorrect);
                saveWords(updated);
              }}
              onFinish={() => goTo("home")}
            />
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
        // A round bullet (○) is often misread by OCR as a plain letter
        // (O / О / 0 / °) sitting right before the real word — strip that too.
        .replace(/^[oOО0°]+(?=[\s\t])\s*/, "")
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

  const toggleSelectMode = () => {
    setSelectMode((v) => !v);
    setSelectedIds(new Set());
  };

  const toggleSelected = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

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
    const tested = (w.stats?.correct || 0) + (w.stats?.wrong || 0);
    if (tested === 0) return 0; // new — never tested, highest priority
    if ((w.stats?.wrong || 0) > 0) return 1; // has mistakes — needs review
    return 2; // mastered — lowest priority
  };
  const sortedWords = [...words].sort((a, b) => wordPriority(a) - wordPriority(b));

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

        {/* File upload */}
        <div style={{ background: COLORS.cloud, borderRadius: 18, padding: 16, display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontFamily: "'Baloo 2', sans-serif", fontWeight: 700, fontSize: 14, color: COLORS.ink }}>
            Загрузить файлом
          </div>
          <div style={{ fontSize: 12, color: "#7A8AA6", lineHeight: 1.5 }}>
            Формат CSV: <code>kazakh,russian</code> в каждой строке. Если в переводе есть запятая — возьми его в кавычки: <code>{`сөз,"значение, важность"`}</code>. Или JSON-массив объектов{" "}
            <code>{`{kz, ru}`}</code>.
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,.json,text/csv,application/json"
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
                const tested = (w.stats?.correct || 0) + (w.stats?.wrong || 0);
                const isNew = tested === 0;
                const hasErrors = (w.stats?.wrong || 0) > 0;
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
                    onClick={selectMode ? () => toggleSelected(w.id) : undefined}
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
                    }}
                  >
                    {selectMode && (
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => toggleSelected(w.id)}
                        style={{ width: 18, height: 18, flexShrink: 0 }}
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
                    {!isNew && hasErrors && (
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
                        ошибки: {w.stats.wrong}
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

function HomeScreen({ profile, avatar, onSwitchProfile, onUpdateName, onOpenWords, onStartLearning, wordCount }) {
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

        <button
          onClick={onStartLearning}
          disabled={wordCount === 0}
          style={{
            background: wordCount === 0 ? "#D8DEE8" : `linear-gradient(135deg, ${COLORS.sun} 0%, #FFB020 100%)`,
            border: "none",
            borderRadius: 18,
            padding: 20,
            display: "flex",
            alignItems: "center",
            gap: 12,
            cursor: wordCount === 0 ? "default" : "pointer",
            textAlign: "left",
            color: COLORS.ink,
            boxShadow: wordCount === 0 ? "none" : "0 8px 20px rgba(255,197,61,0.4)",
          }}
        >
          <div style={{ fontSize: 30 }}>🚀</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: "'Baloo 2', sans-serif", fontWeight: 800, fontSize: 17 }}>
              Начать обучение
            </div>
            <div style={{ fontSize: 12, opacity: 0.8 }}>
              {wordCount === 0 ? "Сначала добавь слова в базу" : "Карточки + мини-тест"}
            </div>
          </div>
        </button>

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

      <div style={{ padding: "0 24px 32px" }}>
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

function LearnSession({ words, onRecordResult, onFinish }) {
  const [queue] = useState(() => getLearningQueue(words, 10));
  const [phase, setPhase] = useState("cards"); // cards | quiz | summary
  const [index, setIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [quizOptions, setQuizOptions] = useState(null);
  const [selectedOption, setSelectedOption] = useState(null);
  const [feedback, setFeedback] = useState(null); // 'correct' | 'wrong'
  const [coins, setCoins] = useState(0);
  const [correctCount, setCorrectCount] = useState(0);
  const [wrongCount, setWrongCount] = useState(0);

  if (queue.length === 0) {
    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100%", alignItems: "center", justifyContent: "center", padding: 24, gap: 16, textAlign: "center" }}>
        <div style={{ fontSize: 40 }}>🤔</div>
        <div style={{ fontFamily: "'Baloo 2', sans-serif", fontWeight: 700, color: COLORS.ink }}>
          Все слова уже выучены без единой ошибки!
        </div>
        <button onClick={onFinish} style={primaryBtnStyle}>
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
