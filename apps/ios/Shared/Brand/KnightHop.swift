import SwiftUI

struct Hop {
    var x: CGFloat = 0
    var y: CGFloat = 0
    var scale: CGFloat = 1
}

extension View {
    /// The knight's move of Hance: up two, across one, land with a bounce.
    func knightHop<T: Equatable>(trigger: T, step: CGFloat) -> some View {
        keyframeAnimator(initialValue: Hop(), trigger: trigger) { view, v in
            view.offset(x: v.x, y: v.y).scaleEffect(v.scale)
        } keyframes: { _ in
            KeyframeTrack(\.y) {
                CubicKeyframe(-step * 2, duration: 0.22)
                CubicKeyframe(-step * 2, duration: 0.16)
                SpringKeyframe(0, duration: 0.5, spring: .bouncy)
            }
            KeyframeTrack(\.x) {
                CubicKeyframe(0, duration: 0.22)
                CubicKeyframe(step, duration: 0.16)
                SpringKeyframe(0, duration: 0.5, spring: .bouncy)
            }
            KeyframeTrack(\.scale) {
                CubicKeyframe(0.9, duration: 0.22)
                CubicKeyframe(0.94, duration: 0.16)
                SpringKeyframe(1, duration: 0.5, spring: .bouncy)
            }
        }
    }
}
