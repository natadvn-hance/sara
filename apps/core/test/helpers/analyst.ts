import type { AnalystOutput } from '@sara/shared'

/** A full Analyst answer: the reading, the short разбор, the body and the price. */
export function analystAnswer(text: string, priceRub: number | null = 90000): AnalystOutput {
  return {
    reading: {
      said: 'Сайт клиники: услуги, врачи, онлайн-запись',
      layers: 'Сама назвала, что нужно; хочет готовый результат',
      wants: 'Начать запись онлайн без долгого запуска',
      who: 'Владелец небольшой клиники',
      risks: 'Сроки не названы',
      job: 'Чтобы запись шла сама',
    },
    hidden_need: 'Боится долгого запуска',
    risk: 'Объём больше, чем звучит',
    condition: 'Брать, если сроки понятны',
    text,
    price_rub: priceRub,
  }
}
