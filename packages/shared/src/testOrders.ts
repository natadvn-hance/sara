/**
 * Test orders inside the live Sara (Boris, 30.10.2026: «Тестовые заявки должны отлетать в основную Сару»). A test
 * order's number has eleven digits from 99, a number Profi.ru does not give (its orders have eight), so every layer
 * tells a test order or its chat from a real one by the number alone, and the mark cannot get lost on the way.
 */
export const TEST_ORDER = /^99\d{9}$/

/** The same as TEST_ORDER for Postgres (`~`). */
export const TEST_ORDER_SQL = '^99[0-9]{9}$'

export const isTestOrder = (id: string | null | undefined): boolean =>
  typeof id === 'string' && TEST_ORDER.test(id)

/** The mark a test order wears wherever Boris sees it: cards, drafts, notices, the pult. */
export const TEST_MARK = '🧪 Тест'

/** An order's title as Boris sees it: a test order's says so first. */
export const shownTitle = (id: string | null | undefined, title: string): string =>
  isTestOrder(id) ? `${TEST_MARK} · ${title}` : title
