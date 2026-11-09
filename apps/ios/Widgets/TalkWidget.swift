import SwiftUI
import WidgetKit

/// The widget of the Home Screen, a page of Hance in small (Boris, 09.11): Lora's square photo with the plate of the
/// app. A tap opens Hance and Lora listens at once; the medium one also calls Sara.
struct TalkWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "pro.hance.talk.widget", provider: TalkWidgetTimeline()) { _ in
            TalkWidgetView()
        }
        .configurationDisplayName("Hance")
        .description("Лора слушает с одного нажатия, Сара рядом.")
        .supportedFamilies([.systemSmall, .systemMedium, .accessoryCircular, .accessoryRectangular, .accessoryInline])
        .contentMarginsDisabled()
    }
}

struct TalkWidgetEntry: TimelineEntry {
    let date: Date
}

/// Nothing in it changes by itself: one entry, never renewed.
struct TalkWidgetTimeline: TimelineProvider {
    func placeholder(in context: Context) -> TalkWidgetEntry { TalkWidgetEntry(date: Date()) }

    func getSnapshot(in context: Context, completion: @escaping (TalkWidgetEntry) -> Void) {
        completion(TalkWidgetEntry(date: Date()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<TalkWidgetEntry>) -> Void) {
        completion(Timeline(entries: [TalkWidgetEntry(date: Date())], policy: .never))
    }
}

struct TalkWidgetView: View {
    @Environment(\.widgetFamily) private var family
    @Environment(\.colorScheme) private var scheme

    static func listen(_ agent: HanceAgent) -> URL {
        URL(string: "hance://talk?go=1&agent=\(agent.rawValue)")!
    }

    var body: some View {
        let p = Palette.of(.lora, dark: scheme == .dark)
        Group {
            switch family {
            case .systemMedium:
                medium(p)
            case .accessoryCircular:
                circular
            case .accessoryRectangular:
                rectangular
            case .accessoryInline:
                Label("Лора · говорить", systemImage: "waveform")
            default:
                small(p)
            }
        }
        .containerBackground(for: .widget) {
            if isAccessory { Color.clear } else { p.bg }
        }
        .widgetURL(Self.listen(.lora))
    }

    private var isAccessory: Bool {
        family == .accessoryCircular || family == .accessoryRectangular || family == .accessoryInline
    }

    /// The Lock Screen, round: her face in a ring. The Lock Screen draws it in one tint.
    private var circular: some View {
        ZStack {
            AccessoryWidgetBackground()
            Image(HanceAgent.lora.cardPhoto)
                .resizable()
                .scaledToFill()
                .clipShape(Circle())
                .padding(4)
            Circle()
                .stroke(lineWidth: 1.5)
                .widgetAccentable()
                .padding(1)
        }
        .accessibilityLabel("Говорить с Лорой")
    }

    /// The Lock Screen, wide: her square face, «[01] ЛОРА» and «Говорить».
    private var rectangular: some View {
        HStack(spacing: 7) {
            Image(HanceAgent.lora.cardPhoto)
                .resizable()
                .scaledToFill()
                .frame(width: 34, height: 34)
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            VStack(alignment: .leading, spacing: 0) {
                Text("\(HanceAgent.lora.index) \(HanceAgent.lora.name)")
                    .monoLabel(8.5)
                    .lineLimit(1)
                    .opacity(0.75)
                Text("Говорить")
                    .font(HanceFont.text(15, .semibold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
                    .widgetAccentable()
            }
            .layoutPriority(1)
            Spacer(minLength: 0)
        }
        .accessibilityLabel("Говорить с Лорой")
    }

    /// Her photo to the edges, the knight in the corner, a plate below: who and «Говорить →».
    private func small(_ p: Palette) -> some View {
        ZStack(alignment: .bottomLeading) {
            Image(HanceAgent.lora.cardPhoto)
                .resizable()
                .scaledToFill()
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 5) {
                    Text(HanceAgent.lora.index).foregroundStyle(p.accentInk)
                    Text(HanceAgent.lora.name).foregroundStyle(p.ink)
                    Spacer(minLength: 0)
                    Rectangle().fill(p.accent).frame(width: 5, height: 5)
                }
                .monoLabel(9)
                Text("Говорить")
                    .font(HanceFont.text(15, .semibold))
                    .lineLimit(1)
                    .foregroundStyle(p.ink)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(p.paper))
            .padding(9)
        }
        .overlay(alignment: .topLeading) {
            PixelKnight(color: .white, cell: 5, gap: 1.5).padding(12)
        }
    }

    /// Her photo on the left; on the right the page: logo, index and role, her big name, «Говорить →» and Sara.
    private func medium(_ p: Palette) -> some View {
        let sara = Palette.of(.sara, dark: scheme == .dark)
        return HStack(spacing: 0) {
            Image(HanceAgent.lora.cardPhoto)
                .resizable()
                .scaledToFill()
                .frame(width: 158)
                .clipped()
                .overlay {
                    CornerMarks(arm: 14, inset: 12)
                        .stroke(.white, style: StrokeStyle(lineWidth: 2, lineCap: .square))
                }
            VStack(alignment: .leading, spacing: 0) {
                HStack {
                    HanceLogo(height: 15, mark: p.accent, word: p.ink)
                    Spacer()
                    PixelKnight(color: p.accent, cell: 4, gap: 1)
                }
                Spacer(minLength: 6)
                HStack(spacing: 6) {
                    Text(HanceAgent.lora.index).foregroundStyle(p.accentInk)
                    Text(HanceAgent.lora.role).foregroundStyle(p.muted)
                }
                .monoLabel(8.5)
                .lineLimit(1)
                Text(HanceAgent.lora.name)
                    .font(HanceFont.text(34, .semibold))
                    .tracking(-1.3)
                    .foregroundStyle(p.ink)
                Spacer(minLength: 6)
                HStack(spacing: 6) {
                    Link(destination: Self.listen(.lora)) {
                        Text("Говорить")
                            .font(HanceFont.text(13, .semibold))
                            .lineLimit(1)
                            .fixedSize()
                            .foregroundStyle(.white)
                            .padding(.horizontal, 14)
                            .frame(height: 30)
                            .background(Capsule().fill(p.accent))
                    }
                    Link(destination: Self.listen(.sara)) {
                        HStack(spacing: 5) {
                            Image(HanceAgent.sara.photo)
                                .resizable()
                                .scaledToFill()
                                .frame(width: 22, height: 22)
                                .clipShape(Circle())
                            Text(HanceAgent.sara.name)
                                .font(HanceFont.text(13, .semibold))
                                .lineLimit(1)
                                .fixedSize()
                                .foregroundStyle(.white)
                        }
                        .padding(.leading, 4)
                        .padding(.trailing, 10)
                        .frame(height: 30)
                        .background(Capsule().fill(sara.accent))
                    }
                }
            }
            .padding(14)
        }
    }
}
