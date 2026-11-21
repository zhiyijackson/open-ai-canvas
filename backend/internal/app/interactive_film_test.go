package app

import (
	"strings"
	"testing"

	"yingce/backend/internal/model"
)

func TestInteractiveFilmNodeMedia(t *testing.T) {
	svc, fake := newDramaTestService(t)
	const user = "usr-drama"
	image := fake.resource(user, "image", "image/gif")
	video := fake.resource(user, "video", "video/mp4")
	media := &model.FilmNodeMedia{Kind: "event", ResourceID: image}
	req := FilmDraftRequest{Title: "站台", Graph: model.FilmGraph{Start: "a", Scenes: []model.FilmScene{
		{ID: "a", Title: "翻开票根", Script: "查看票根", Mode: "next", Media: media, Exits: []model.FilmExit{{Target: "b", Label: "翻面", Spot: &model.FilmSpot{X: 45, Y: 55}, Feedback: "末班车"}}},
		{ID: "b", Title: "上车", Script: "车门关闭", Mode: "ending", Media: &model.FilmNodeMedia{Kind: "clip", ResourceID: video}},
	}}}
	film, err := svc.SaveInteractiveFilm(user, "", req)
	if err != nil {
		t.Fatal(err)
	}
	stored, err := svc.InteractiveFilm(user, film.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Graph.Scenes[0].Exits[0].Spot.Y != 55 || stored.Graph.Scenes[0].Exits[0].Feedback != "末班车" || stored.Graph.Scenes[1].Media.ResourceID != video {
		t.Fatal(stored.Graph)
	}
	refs, err := svc.repo.DramaResourceReferences(user, []string{image, video})
	if err != nil || len(refs) != 2 {
		t.Fatalf("node media references: %+v %v", refs, err)
	}
	if _, err := svc.ProduceInteractiveFilm(user, film.ID, FilmProductionRequest{Revision: film.Revision, SceneIDs: []string{"a"}}); err == nil {
		t.Fatal("created episode for event")
	}
	for _, resource := range []string{video, fake.resource("other", "image", "image/png")} {
		media.ResourceID = resource
		if _, err := svc.SaveInteractiveFilm(user, "", req); err == nil {
			t.Fatal("accepted wrong type or owner")
		}
	}
}

func TestInteractiveFilmDraftOwnershipAndRevision(t *testing.T) {
	svc, _ := newDramaTestService(t)
	req := FilmDraftRequest{Title: "旧车票", Novel: "站台的故事"}
	film, err := svc.SaveInteractiveFilm("usr-drama", "", req)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = svc.InteractiveFilm("other", film.ID); err == nil {
		t.Fatal("cross-account read")
	}
	req.Revision = film.Revision
	if _, err = svc.SaveInteractiveFilm("other", film.ID, req); err == nil {
		t.Fatal("cross-account write")
	}
	if _, err = svc.ProduceInteractiveFilm("other", film.ID, FilmProductionRequest{}); err == nil {
		t.Fatal("cross-account production")
	}
	req.Direction = "保留原著结局"
	req.Graph = model.FilmGraph{Start: "a", Scenes: []model.FilmScene{{ID: "a", Title: "票根", Script: "翻面", Mode: "ending", Track: &model.FilmTrack{ResourceID: "cut-v1", DurationMs: 30000, Cues: []model.FilmCue{{ID: "ticket", Kind: "hotspot", AtMs: 6000, EndMs: 10000, X: 52, Y: 68, Label: "翻票根"}}}}}}
	if _, err = svc.SaveInteractiveFilm("usr-drama", film.ID, req); err != nil {
		t.Fatal(err)
	}
	req.Direction = "旧窗口"
	if _, err = svc.SaveInteractiveFilm("usr-drama", film.ID, req); err == nil {
		t.Fatal("stale write")
	}
	stored, err := svc.InteractiveFilm("usr-drama", film.ID)
	if err != nil || stored.Direction != "保留原著结局" {
		t.Fatalf("stored draft %v, %v", stored, err)
	}
	if got := stored.Graph.Scenes[0].Track; got == nil || got.ResourceID != "cut-v1" || len(got.Cues) != 1 || got.Cues[0].AtMs != 6000 || got.Cues[0].Y != 68 {
		t.Fatalf("track round trip: %+v", got)
	}
}

func TestInteractiveFilmCueCopyLimits(t *testing.T) {
	svc, _ := newDramaTestService(t)
	question, name := strings.Repeat("🌙", 80), strings.Repeat("🎟", 60)
	track := &model.FilmTrack{Cues: []model.FilmCue{{ID: "ask", Kind: "choice", Question: question}, {ID: "ticket", Kind: "hotspot", CollectionName: name}}}
	req := FilmDraftRequest{Title: "登记台", Graph: model.FilmGraph{Start: "a", Scenes: []model.FilmScene{{ID: "a", Mode: "choice", Track: track}}}}
	film, err := svc.SaveInteractiveFilm("usr-drama", "", req)
	if err != nil {
		t.Fatal(err)
	}
	req.Revision = film.Revision
	track.Cues[0].Question += "？"
	if _, err := svc.SaveInteractiveFilm("usr-drama", film.ID, req); err == nil {
		t.Fatal("accepted 81-character question")
	}
	track.Cues[0].Question = question
	track.Cues[1].CollectionName += "票"
	if _, err := svc.SaveInteractiveFilm("usr-drama", film.ID, req); err == nil {
		t.Fatal("accepted 61-character collection name")
	}
	stored, err := svc.InteractiveFilm("usr-drama", film.ID)
	if err != nil {
		t.Fatal(err)
	}
	cues := stored.Graph.Scenes[0].Track.Cues
	if stored.Revision != film.Revision || cues[0].Question != question || cues[1].CollectionName != name {
		t.Fatal("stored cue copy or revision changed")
	}
}

func TestInteractiveFilmImportRetry(t *testing.T) {
	svc, _ := newDramaTestService(t)
	const owner = "usr-drama"
	req := FilmDraftRequest{CreationKey: "same-submission", Title: "闭馆"}
	first, err := svc.SaveInteractiveFilm(owner, "", req)
	if err != nil {
		t.Fatal(err)
	}
	edited, err := svc.SaveInteractiveFilm(owner, first.ID, FilmDraftRequest{Title: "改稿", Revision: first.Revision})
	if err != nil {
		t.Fatal(err)
	}
	retry, err := svc.SaveInteractiveFilm(owner, "", req)
	if err != nil || retry.ID != first.ID || retry.Revision != edited.Revision || retry.Title != edited.Title {
		t.Fatalf("retry lost the existing work: %v, %v", retry, err)
	}
	other, err := svc.SaveInteractiveFilm("other", "", req)
	if err != nil || other.ID == first.ID {
		t.Fatalf("creation key crossed accounts: %v, %v", other, err)
	}
	req.CreationKey = "new-submission"
	second, err := svc.SaveInteractiveFilm(owner, "", req)
	if err != nil || second.ID == first.ID {
		t.Fatalf("distinct submission reused work: %v, %v", second, err)
	}
	list, err := svc.ListInteractiveFilms(owner)
	if err != nil || len(list) != 2 {
		t.Fatalf("unexpected work count %d: %v", len(list), err)
	}
}

func TestInteractiveFilmProduction(t *testing.T) {
	svc, fake := newDramaTestService(t)
	const user = "usr-drama"
	// The model catalog resolves defaults from enabled platform models.
	for _, capability := range []string{"text", "image"} {
		if err := fake.db.Create(&model.ChannelModel{ID: "film-" + capability, ChannelID: "ch", ModelKey: capability, Capability: capability, Enabled: true}).Error; err != nil {
			t.Fatal(err)
		}
	}
	req := FilmDraftRequest{Title: "站台", Graph: model.FilmGraph{Start: "a", Scenes: []model.FilmScene{
		{ID: "a", Title: "候车", Script: "主角走上站台。", Mode: "next", Exits: []model.FilmExit{{Target: "b"}}},
		{ID: "b", Title: "离站", Script: "主角登上列车。", Mode: "ending"},
	}}}
	film, err := svc.SaveInteractiveFilm(user, "", req)
	if err != nil {
		t.Fatal(err)
	}
	produce := func(ids ...string) {
		t.Helper()
		f, e := svc.ProduceInteractiveFilm(user, film.ID, FilmProductionRequest{Revision: film.Revision, SceneIDs: ids, Models: fakeDramaModels})
		if e != nil {
			t.Fatal(e)
		}
		film = f
	}
	produce("a")
	first := film.Takes["a"]
	project := film.ProjectID
	produce("a")
	if film.Takes["a"] != first {
		t.Fatal("duplicate take")
	}
	if err := fake.db.Exec("CREATE TRIGGER reject_film_write BEFORE UPDATE ON interactive_films BEGIN SELECT RAISE(ABORT, 'rollback'); END").Error; err != nil {
		t.Fatal(err)
	}
	if _, err := svc.ProduceInteractiveFilm(user, film.ID, FilmProductionRequest{Revision: film.Revision, SceneIDs: []string{"b"}}); err == nil {
		t.Fatal("expected failure")
	}
	rows, err := svc.repo.DramaEpisodes(project)
	if err != nil || len(rows) != 1 {
		t.Fatalf("partial handoff: %d %v", len(rows), err)
	}
	if err := fake.db.Exec("DROP TRIGGER reject_film_write").Error; err != nil {
		t.Fatal(err)
	}
	produce("a", "b")
	rows, err = svc.repo.DramaEpisodes(project)
	if err != nil || film.ProjectID != project || len(rows) != 2 || rows[1].SourceFormat != model.DramaSourceScript || rows[1].ID != film.Takes["b"].EpisodeID {
		t.Fatalf("handoff: %+v %v", rows, err)
	}
}
