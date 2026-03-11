#!/usr/bin/env node

/**
 * build-data.js
 * =============
 * InSight Survey Data Builder
 * Champlain College Career Collaborative
 *
 * Parses Canvas quiz CSV exports from Kickoff/ and Exit/ folders and generates
 * a single src/data.json file that the React dashboard imports.
 *
 * USAGE:
 *   node build-data.js
 *
 * WORKFLOW:
 *   1. Export "Student Analysis Report" CSV from each Canvas quiz
 *   2. Drop kickoff CSVs into the Kickoff/ folder
 *   3. Drop exit CSVs into the Exit/ folder
 *   4. Run: node build-data.js
 *   5. The React app hot-reloads with the new data (if npm start is running)
 *
 * The script auto-detects cohort names from the "section" column in each CSV.
 * Rows with no section assignment are skipped (these are typically test accounts).
 */

const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PROJECT_DIR = __dirname;
const KICKOFF_DIR = path.join(PROJECT_DIR, "Kickoff");
const EXIT_DIR = path.join(PROJECT_DIR, "Exit");
const OUTPUT_PATH = path.join(PROJECT_DIR, "src", "data.json");

// The 5 Likert response options, in order from most negative to most positive.
const LIKERT_SCALE = [
  "Very untrue of me",
  "Somewhat untrue of me",
  "Neutral",
  "Somewhat true of me",
  "Very true of me",
];

// Known typos found in Canvas quiz exports. Add new ones here as they surface.
// The parser normalizes responses through this map before counting.
const LIKERT_TYPOS = {
  "Somwhat true of me": "Somewhat true of me",
  "Somwhat untrue of me": "Somewhat untrue of me",
};

// Each question is matched by a unique keyword fragment found in the CSV header.
// This handles the fact that Canvas prefixes headers with question IDs that change
// between quiz instances, and sometimes introduces newlines in the header text.
//
// Order matters: this defines the canonical 20-question sequence used by the dashboard.
const QUESTION_MATCHERS = [
  { label: "Identify personal values",               keyword: "identify my personal values" },
  { label: "Ask for help when needed",               keyword: "ask for help when I need it" },
  { label: "Help others through difficult situations", keyword: "helping others through difficult" },
  { label: "Recognize when I need help",             keyword: "recognize when I need help" },
  { label: "Reflect on what's important in life",    keyword: "think about what's important in life" },
  { label: "Goals for work/life integration",        keyword: "goals related to positive work/life" },
  { label: "Follow a financial plan",                keyword: "financial commitment" },
  { label: "Build and manage a monthly budget",      keyword: "building and managing a monthly budget" },
  { label: "Working knowledge of credit",            keyword: "working knowledge of credit" },
  { label: "Follow through with a savings plan",     keyword: "following through with a savings plan" },
  { label: "Research cost of living",                keyword: "research the cost of living" },
  { label: "Negotiate salary",                       keyword: "negotiating my salary" },
  { label: "Resume confidence",                      keyword: "resume that I would feel confident" },
  { label: "LinkedIn profile",                       keyword: "LinkedIn Profile" },
  { label: "Write a cover letter",                   keyword: "writing a cover letter" },
  { label: "Attend a networking event",              keyword: "attending a networking event" },
  { label: "Elevator pitch",                         keyword: "speak about my professional interests" },
  { label: "Plan to pay off debts",                  keyword: "plan to pay off my debts" },
  { label: "Job interview confidence",               keyword: "have a job interview" },
  { label: "Ready to launch career",                 keyword: "ready to launch my career" },
];

const QUESTION_LABELS = QUESTION_MATCHERS.map((q) => q.label);


// ---------------------------------------------------------------------------
// Simple CSV parser (no external dependencies)
// ---------------------------------------------------------------------------
// Canvas CSVs can have quoted fields with commas and newlines inside them,
// so we need a proper parser, not just split(",").

function parseCSVText(text) {
  const rows = [];
  let current = [];
  let field = "";
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        // Check for escaped quote ""
        if (i + 1 < text.length && text[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          // End of quoted field
          inQuotes = false;
          i++;
        }
      } else {
        field += ch;
        i++;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
        i++;
      } else if (ch === ",") {
        current.push(field);
        field = "";
        i++;
      } else if (ch === "\n" || ch === "\r") {
        current.push(field);
        field = "";
        if (ch === "\r" && i + 1 < text.length && text[i + 1] === "\n") {
          i++; // skip \r\n
        }
        i++;
        if (current.length > 1 || current[0] !== "") {
          rows.push(current);
        }
        current = [];
      } else {
        field += ch;
        i++;
      }
    }
  }
  // Final field/row
  current.push(field);
  if (current.length > 1 || current[0] !== "") {
    rows.push(current);
  }

  return rows;
}


// ---------------------------------------------------------------------------
// CSV Processing
// ---------------------------------------------------------------------------

/**
 * Match the 20 canonical questions to column indices in a CSV header row.
 * Returns an array of 20 column indices (or null if a question isn't found).
 */
function findQuestionColumns(headers) {
  return QUESTION_MATCHERS.map(({ keyword }) => {
    for (let i = 0; i < headers.length; i++) {
      // Collapse whitespace/newlines in the header for matching
      const cleaned = headers[i].replace(/\s+/g, " ");
      if (cleaned.toLowerCase().includes(keyword.toLowerCase())) {
        return i;
      }
    }
    return null;
  });
}

/**
 * Parse a single Canvas Student Analysis Report CSV file.
 * Returns an array of dataset objects (one per section/cohort found).
 */
function parseCSVFile(filepath, surveyType) {
  // Read file, strip BOM if present
  let text = fs.readFileSync(filepath, "utf-8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const rows = parseCSVText(text);
  if (rows.length < 2) {
    console.warn(`  Warning: ${path.basename(filepath)} has no data rows.`);
    return [];
  }

  const headers = rows[0];
  const dataRows = rows.slice(1);
  const qCols = findQuestionColumns(headers);

  // Find the "section" column
  const sectionIdx = headers.findIndex(
    (h) => h.trim().toLowerCase() === "section"
  );

  // Group rows by section. Since each CSV is exported per class year, all rows
  // belong to the same cohort. Students with empty section fields (dropped out,
  // late enrollments, section swaps) are assigned to the majority section in
  // the file, because their survey data is still valid for that cohort.
  const sectionGroups = {};
  const unsectioned = [];
  for (const row of dataRows) {
    const section =
      sectionIdx >= 0 && sectionIdx < row.length ? row[sectionIdx].trim() : "";
    if (!section) {
      unsectioned.push(row);
    } else {
      if (!sectionGroups[section]) sectionGroups[section] = [];
      sectionGroups[section].push(row);
    }
  }

  // Assign unsectioned rows to the largest section in this file
  if (unsectioned.length > 0) {
    const sections = Object.entries(sectionGroups);
    if (sections.length > 0) {
      // Find the section with the most rows
      const largest = sections.reduce((a, b) => (a[1].length >= b[1].length ? a : b));
      largest[1].push(...unsectioned);
      console.log(
        `      (${unsectioned.length} student${unsectioned.length > 1 ? "s" : ""} with no section assigned to ${largest[0]})`
      );
    } else {
      // No sections at all in the file; create a fallback
      const fallback = `Unknown (${path.basename(filepath)})`;
      sectionGroups[fallback] = unsectioned;
      console.log(
        `      (${unsectioned.length} student${unsectioned.length > 1 ? "s" : ""} with no section, using fallback name)`
      );
    }
  }

  // Build a dataset for each section
  const datasets = [];
  for (const [section, sRows] of Object.entries(sectionGroups)) {
    const questions = {};

    for (let qi = 0; qi < QUESTION_LABELS.length; qi++) {
      const qLabel = QUESTION_LABELS[qi];
      const colIdx = qCols[qi];
      const counts = {};
      for (const likert of LIKERT_SCALE) counts[likert] = 0;

      if (colIdx !== null) {
        for (const row of sRows) {
          if (colIdx < row.length) {
            let val = row[colIdx].trim();
            // Normalize known typos (e.g. "Somwhat" -> "Somewhat")
            if (LIKERT_TYPOS[val]) val = LIKERT_TYPOS[val];
            if (LIKERT_SCALE.includes(val)) {
              counts[val]++;
            }
          }
        }
      }
      questions[qLabel] = counts;
    }

    // Clean up section name for display
    const cohort = section
      .replace("InSight - ", "")
      .replace("Insight - ", "");

    datasets.push({
      name: `${surveyType} - ${cohort}`,
      type: surveyType,
      cohort: cohort,
      n: sRows.length,
      sourceFile: path.basename(filepath),
      questions: questions,
    });
  }

  return datasets;
}


// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  console.log("=".repeat(60));
  console.log("InSight Survey Data Builder");
  console.log("=".repeat(60));

  // Ensure folders exist
  for (const dir of [KICKOFF_DIR, EXIT_DIR]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      console.log(`  Created: ${dir}`);
    }
  }

  // Ensure src/ folder exists
  const srcDir = path.join(PROJECT_DIR, "src");
  if (!fs.existsSync(srcDir)) {
    fs.mkdirSync(srcDir, { recursive: true });
  }

  // Collect all datasets
  const allDatasets = [];

  for (const [dir, surveyType] of [
    [KICKOFF_DIR, "Kickoff"],
    [EXIT_DIR, "Exit"],
  ]) {
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith(".csv"))
      .sort();

    if (files.length === 0) {
      console.log(`\n  No CSV files found in ${path.basename(dir)}/`);
      continue;
    }

    console.log(`\n  ${path.basename(dir)}/ (${files.length} file${files.length > 1 ? "s" : ""}):`);

    for (const file of files) {
      const filepath = path.join(dir, file);
      try {
        const datasets = parseCSVFile(filepath, surveyType);
        for (const ds of datasets) {
          // Compute average responses per question as a sanity check
          const avgResp =
            QUESTION_LABELS.reduce(
              (sum, q) =>
                sum + Object.values(ds.questions[q]).reduce((a, b) => a + b, 0),
              0
            ) / QUESTION_LABELS.length;

          console.log(
            `    ${ds.name} (n=${ds.n}, avg responses/q=${Math.round(avgResp)}) from ${ds.sourceFile}`
          );
        }
        allDatasets.push(...datasets);
      } catch (err) {
        console.error(`    ERROR parsing ${file}: ${err.message}`);
      }
    }
  }

  if (allDatasets.length === 0) {
    console.log("\n  No data found!");
    console.log("  Drop Canvas Student Analysis Report CSVs into Kickoff/ and Exit/ folders.");
    console.log("  Then re-run: node build-data.js\n");
    // Still write an empty data file so the app doesn't crash
    const emptyData = { datasets: [], questions: QUESTION_LABELS, likertScale: LIKERT_SCALE };
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(emptyData, null, 2));
    console.log(`  Wrote empty ${path.relative(PROJECT_DIR, OUTPUT_PATH)}`);
    return;
  }

  // Remove sourceFile from output (not needed by the dashboard)
  const cleanedDatasets = allDatasets.map(({ sourceFile, ...rest }) => rest);

  // Build the output structure
  const output = {
    datasets: cleanedDatasets,
    questions: QUESTION_LABELS,
    likertScale: LIKERT_SCALE,
  };

  // Write JSON
  const jsonStr = JSON.stringify(output, null, 2);
  fs.writeFileSync(OUTPUT_PATH, jsonStr);

  const sizeKB = (Buffer.byteLength(jsonStr) / 1024).toFixed(1);
  console.log(`\n  Wrote ${path.relative(PROJECT_DIR, OUTPUT_PATH)} (${sizeKB} KB)`);
  console.log(`  ${cleanedDatasets.length} dataset(s): ${cleanedDatasets.map((d) => d.name).join(", ")}`);
  console.log("\n  If npm start is running, the dashboard will hot-reload automatically.");
  console.log("  Done!\n");
}

main();
