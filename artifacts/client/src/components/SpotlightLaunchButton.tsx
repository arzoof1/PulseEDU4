import { useEffect, useRef, useState } from "react";

// Sidebar standout entry point for the Spotlight student picker. Looks
// (and feels) different from the rest of the nav so it reads as
// "playful tool" rather than "page in a list" — teachers reach for it
// mid-lesson and the rotating label is meant to invite a tap. Behavior
// is identical to a regular nav item (sets activeSection to "spotlight").
const ROTATING_LABELS = [
  "Pick a scholar",
  "Who'll be the next genius?",
  "Spotlight time!",
  "Whose brain are we tapping?",
  "Find me a thinker",
  "Roll the spotlight",
  "Tag — you're it!",
  "Surprise me",
];

const ROTATE_INTERVAL_MS = 3500;

interface SpotlightLaunchButtonProps {
  active: boolean;
  onClick: () => void;
}

export default function SpotlightLaunchButton({
  active,
  onClick,
}: SpotlightLaunchButtonProps) {
  const [labelIndex, setLabelIndex] = useState(0);
  const [fadeIn, setFadeIn] = useState(true);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Tracked separately so the unmount cleanup can clear an in-flight
  // fade-swap timeout — otherwise the nested setTimeout could fire
  // after unmount and trigger a "set state on unmounted component"
  // warning (and a tiny memory leak via the captured closures).
  const fadeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    intervalRef.current = setInterval(() => {
      // Cross-fade: fade out, swap label, fade in. The 200ms in-between
      // gives the eye a beat to register the change rather than the
      // text snapping mid-sentence.
      setFadeIn(false);
      fadeTimeoutRef.current = setTimeout(() => {
        setLabelIndex((i) => (i + 1) % ROTATING_LABELS.length);
        setFadeIn(true);
        fadeTimeoutRef.current = null;
      }, 200);
    }, ROTATE_INTERVAL_MS);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (fadeTimeoutRef.current) clearTimeout(fadeTimeoutRef.current);
    };
  }, []);

  return (
    <button
      type="button"
      onClick={onClick}
      className={"spotlight-launch" + (active ? " active" : "")}
      aria-label="Spotlight — pick a student"
    >
      <span className="spotlight-launch-glow" aria-hidden />
      <span className="spotlight-launch-icon" aria-hidden>
        ✨
      </span>
      <span
        className={
          "spotlight-launch-label" + (fadeIn ? " visible" : " fading")
        }
      >
        {ROTATING_LABELS[labelIndex]}
      </span>
      <span className="spotlight-launch-sparkles" aria-hidden>
        <span className="sl-spark sl-spark-1">✦</span>
        <span className="sl-spark sl-spark-2">✦</span>
        <span className="sl-spark sl-spark-3">✦</span>
      </span>
    </button>
  );
}
