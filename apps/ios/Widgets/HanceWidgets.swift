import AppIntents
import SwiftUI
import WidgetKit

@main
struct HanceWidgets: WidgetBundle {
    var body: some Widget {
        TalkLiveActivity()
        TalkControl()
        CallSaraControl()
    }
}

/// A button for the Control Center, the Lock Screen and the side button (Settings, Action Button, Controls): Lora
/// listens at once, without opening the app.
struct TalkControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "pro.hance.talk.control.lora") {
            ControlWidgetButton(action: TalkIntent(agent: .lora)) {
                Label("Лора слушает", systemImage: "waveform")
            }
        }
        .displayName("Говорить с Лорой")
        .description("Hance сразу слушает, не открываясь.")
    }
}

/// The same for Sara.
struct CallSaraControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "pro.hance.talk.control.sara") {
            ControlWidgetButton(action: TalkIntent(agent: .sara)) {
                Label("Сара слушает", systemImage: "person.wave.2.fill")
            }
        }
        .displayName("Говорить с Сарой")
        .description("Сара сразу слушает: заявки, клиенты, отклики.")
    }
}
