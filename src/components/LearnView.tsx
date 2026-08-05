import { useState } from "react";
import { LESSONS } from "../data/lessons";
import LessonVisual from "./LessonVisuals";

export default function LearnView() {
  const [openId, setOpenId] = useState<string>(LESSONS[0].id);

  return (
    <div className="learn">
      <div className="learn-intro card highlight">
        <h3>Learn Vedic Astrology as you go</h3>
        <p className="note">
          These lessons build from the ground up — the zodiac and planets, then houses, nakshatras,
          the dasha timing system, aspects, yogas and finally the theory of remedies. Read them
          alongside your own chart to see each idea in action.
        </p>
      </div>

      <div className="lesson-list">
        {LESSONS.map((lesson) => {
          const open = openId === lesson.id;
          return (
            <div className={`lesson ${open ? "open" : ""}`} key={lesson.id}>
              <button className="lesson-head" onClick={() => setOpenId(open ? "" : lesson.id)}>
                <span className="lesson-title">{lesson.title}</span>
                <span className={`level ${lesson.level.toLowerCase()}`}>{lesson.level}</span>
                <span className="chevron">{open ? "▾" : "▸"}</span>
              </button>
              {open && (
                <div className="lesson-body">
                  <p className="lesson-summary">{lesson.summary}</p>
                  {lesson.sections.map((s, i) => (
                    <div className="lesson-section" key={i}>
                      <h4>{s.heading}</h4>
                      <p>{s.body}</p>
                      {s.visual && <LessonVisual id={s.visual} />}
                      {s.points && (
                        <ul>
                          {s.points.map((pt, j) => (
                            <li key={j}>{pt}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
