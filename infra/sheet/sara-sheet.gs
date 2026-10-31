/**
 * Сара пишет свои отклики во вкладку «Лог клиентов» этой таблицы (docs/ops/google-sheet.md).
 *
 * Как поставить: Расширения → Apps Script, стереть всё в редакторе, вставить этот текст целиком, сохранить,
 * затем Развернуть → Новое развертывание → Веб-приложение, «Выполнять от моего имени», доступ «Все».
 *
 * Что делает: на каждый отклик Сары одна строка в конце лога, дальше Сара обновляет в ней этап, суммы и заметку.
 * Ячейку, которую ты поправил руками, Сара больше не трогает. Строку, которую ты удалил, она не возвращает.
 * Вкладки «Воронка» и «Сводка по месяцам» скрипт не трогает: новые строки вставляются внутрь их диапазонов.
 */

// Секрет знает только сервер Сары: без него скрипт ничего не пишет.
const SECRET = '__SARA_SHEET_SECRET__'
// Вкладка лога: её имя содержит эти слова (значок в начале не важен).
const SHEET_NAME = 'Лог клиентов'
// Строка 2 это шапка, данные с третьей.
const FIRST_ROW = 3
const COLUMNS = ['month', 'client', 'service', 'stage', 'deal', 'spend', 'ltv', 'note']
// Невидимая метка строки: номер заказа на Профи.ру. Она едет вместе со строкой, если строки вставляют выше.
const KEY = 'sara'

// biome-ignore lint/correctness/noUnusedVariables: Google зовёт её сам, когда открывают ссылку
function doGet() {
  return ContentService.createTextOutput('Сара: скрипт таблицы работает.')
}

// biome-ignore lint/correctness/noUnusedVariables: Google зовёт её сам на запрос Сары
function doPost(e) {
  let body
  try {
    body = JSON.parse(e.postData.contents)
  } catch {
    return answer({ ok: false, error: 'bad_json' })
  }
  if (!body || SECRET.indexOf('__') === 0 || body.secret !== SECRET) {
    return answer({ ok: false, error: 'secret' })
  }
  const lock = LockService.getScriptLock()
  lock.waitLock(30000)
  try {
    const sheet = findSheet()
    if (!sheet) return answer({ ok: false, error: 'no_sheet' })
    if (body.ping) {
      return answer({ ok: true, sheet: sheet.getName(), rows: lastRow(sheet) - FIRST_ROW + 1 })
    }
    const rows = indexRows(sheet)
    const ops = body.ops || []
    const results = []
    for (let i = 0; i < ops.length; i++) {
      try {
        results.push(apply(sheet, rows, ops[i]))
      } catch (err) {
        results.push({ key: ops[i].key, status: 'error', error: String(err) })
      }
    }
    SpreadsheetApp.flush()
    return answer({ ok: true, results: results })
  } finally {
    lock.releaseLock()
  }
}

/** Одна строка: найти по метке и обновить, или добавить в конец лога. */
function apply(sheet, rows, op) {
  let row = rows[op.key]
  if (!row) {
    if (!op.create) return { key: op.key, status: 'gone' }
    row = appendRow(sheet, rows)
    sheet.getRange(row, 1, 1, COLUMNS.length).setValues([COLUMNS.map((c) => cell(op.values[c]))])
    sheet.getRange(`${row}:${row}`).addDeveloperMetadata(KEY, op.key)
    rows[op.key] = row
    return { key: op.key, status: 'created', written: Object.keys(op.values), kept: [] }
  }
  // Пишем ячейку, только если в ней то, что Сара писала в прошлый раз: иначе её поправил ты.
  const now = sheet.getRange(row, 1, 1, COLUMNS.length).getValues()[0]
  const written = []
  const kept = []
  for (const c in op.values) {
    const i = COLUMNS.indexOf(c)
    if (i < 0) continue
    const have = norm(now[i])
    if (have === norm(op.values[c])) {
      written.push(c)
    } else if (have === norm(op.expect ? op.expect[c] : '')) {
      sheet.getRange(row, i + 1).setValue(cell(op.values[c]))
      written.push(c)
    } else {
      kept.push(c)
    }
  }
  return { key: op.key, status: 'updated', written: written, kept: kept }
}

/**
 * Новая строка сразу под последней заполненной. Вставка внутрь диапазона формул «Воронки» и «Сводки» растягивает
 * их диапазоны, поэтому формулы считают и новые строки.
 */
function appendRow(sheet, rows) {
  const last = lastRow(sheet)
  if (last < FIRST_ROW) return FIRST_ROW
  sheet.insertRowAfter(last)
  for (const k in rows) if (rows[k] > last) rows[k] += 1
  return last + 1
}

/** Последняя строка лога, где заполнен месяц или клиент; FIRST_ROW - 1, если лог пуст. */
function lastRow(sheet) {
  const n = sheet.getLastRow()
  if (n < FIRST_ROW) return FIRST_ROW - 1
  const vals = sheet.getRange(FIRST_ROW, 1, n - FIRST_ROW + 1, 2).getValues()
  for (let i = vals.length - 1; i >= 0; i--) {
    if (norm(vals[i][0]) || norm(vals[i][1])) return FIRST_ROW + i
  }
  return FIRST_ROW - 1
}

/** Номер заказа → номер строки, по меткам Сары. */
function indexRows(sheet) {
  const map = {}
  const found = sheet.createDeveloperMetadataFinder().withKey(KEY).find()
  for (let i = 0; i < found.length; i++) {
    const loc = found[i].getLocation()
    if (loc.getLocationType() !== SpreadsheetApp.DeveloperMetadataLocationType.ROW) continue
    map[found[i].getValue()] = loc.getRow().getRow()
  }
  return map
}

function findSheet() {
  const sheets = SpreadsheetApp.getActiveSpreadsheet().getSheets()
  for (let i = 0; i < sheets.length; i++) {
    if (sheets[i].getName().indexOf(SHEET_NAME) >= 0) return sheets[i]
  }
  return null
}

/** Как сравнивать ячейки: 30000 и «30000» одно и то же, пробелы по краям не важны. */
function norm(v) {
  if (v === null || v === undefined) return ''
  if (typeof v === 'number') return String(v)
  const s = String(v).trim()
  if (/^-?\d+(\.\d+)?$/.test(s)) return String(Number(s))
  return s
}

function cell(v) {
  return v === null || v === undefined ? '' : v
}

function answer(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(
    ContentService.MimeType.JSON,
  )
}
