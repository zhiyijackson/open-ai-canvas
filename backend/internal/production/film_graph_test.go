package production

import (
	"testing"
	"yingce/backend/internal/model"
)

func TestFilmTrackValidatesAllArrivals(t *testing.T) {
	graph := model.FilmGraph{Start: "start", Scenes: []model.FilmScene{
		{ID: "start", Title: "物件", Script: "取一件。", Mode: "choice", Exits: []model.FilmExit{{Label: "围裙", Target: "ask", Item: "围裙"}, {Label: "录音机", Target: "ask", Item: "录音机"}}},
		{ID: "ask", Title: "问询", Script: "留下什么？", Mode: "choice", Exits: []model.FilmExit{{ID: "sign", Label: "署名", Target: "end", RequiresItem: "围裙"}, {ID: "keep", Label: "暂存", Target: "end"}}, Track: &model.FilmTrack{ResourceID: "media", DurationMs: 30000, Cues: []model.FilmCue{{ID: "ticket", Kind: "hotspot", Label: "票根", AtMs: 6000, EndMs: 10000}, {ID: "choose", Kind: "choice", AtMs: 16000, TimeoutMs: 2000, DefaultExit: "keep"}}}},
		{ID: "end", Title: "结局", Script: "灯灭。", Mode: "ending", Clue: "ticket", Response: "已见过票根"},
	}}
	if err := ValidateFilmGraph(graph); err != nil {
		t.Fatal(err)
	}
	track := graph.Scenes[1].Track
	track.Cues[1].DefaultExit = "sign"
	if ValidateFilmGraph(graph) == nil {
		t.Fatal("conditional default should not work for recorder")
	}
	track.Cues[1].DefaultExit = "keep"
	track.DurationMs = 12000
	if ValidateFilmGraph(graph) == nil {
		t.Fatal("cue outside new cut")
	}
	track.DurationMs = 30000
	track.Cues[1].AtMs = 9999
	if ValidateFilmGraph(graph) == nil {
		t.Fatal("overlapping input windows")
	}
}

func TestFilmGraph(t *testing.T) {
	scene := func(id, mode string, targets ...string) model.FilmScene {
		s := model.FilmScene{ID: id, Title: id, Script: "正文", Mode: mode}
		for _, v := range targets {
			s.Exits = append(s.Exits, model.FilmExit{Label: v, Target: v})
		}
		return s
	}
	cases := []struct {
		name   string
		valid  bool
		scenes []model.FilmScene
	}{
		{"merge", true, []model.FilmScene{scene("a", "choice", "b", "c"), scene("b", "next", "d"), scene("c", "next", "d"), scene("d", "ending")}},
		{"cycle", false, []model.FilmScene{scene("a", "next", "b"), scene("b", "next", "a")}},
		{"dangling", false, []model.FilmScene{scene("a", "next", "b")}},
		{"unreachable", false, []model.FilmScene{scene("a", "ending"), scene("b", "ending")}},
		{"missing ending", false, []model.FilmScene{scene("a", "choice")}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			err := ValidateFilmGraph(model.FilmGraph{Start: "a", Scenes: c.scenes})
			if (err == nil) != c.valid {
				t.Fatal(err)
			}
		})
	}
}
