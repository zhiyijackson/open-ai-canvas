package app

import (
	"errors"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"gorm.io/gorm"
	"yingce/backend/builtin"
	"yingce/backend/internal/model"
	"yingce/backend/internal/production"
	"yingce/backend/internal/repository"
)

type FilmDraftRequest struct {
	CreationKey string          `json:"creationKey"`
	Title       string          `json:"title"`
	Novel       string          `json:"novel"`
	Direction   string          `json:"direction"`
	Graph       model.FilmGraph `json:"graph"`
	Revision    int64           `json:"revision"`
}
type FilmProductionRequest struct {
	Models   DramaModels `json:"models"`
	Revision int64       `json:"revision"`
	SceneIDs []string    `json:"sceneIds"`
}

var filmSceneID = regexp.MustCompile("^[a-zA-Z0-9_-]{1,64}$")

func (s *Service) FilmAdaptationMethod() (string, error) {
	body, err := builtin.FS.ReadFile("互动影游改编/SKILL.md")
	return string(body), err
}

func filmError(err error) error {
	switch {
	case errors.Is(err, gorm.ErrRecordNotFound):
		return NotFound("作品不存在")
	case errors.Is(err, repository.ErrFilmRevision):
		return NewAppError(http.StatusConflict, "作品已更新，请重新载入后再保存")
	case errors.Is(err, repository.ErrProjectNameConflict):
		return dramaNameConflict()
	default:
		return err
	}
}
func (s *Service) ListInteractiveFilms(userID string) ([]model.InteractiveFilm, error) {
	if userID == "" {
		return nil, Unauthorized("请先登录")
	}
	return s.repo.ListInteractiveFilms(userID)
}
func (s *Service) InteractiveFilm(userID, id string) (*model.InteractiveFilm, error) {
	if userID == "" {
		return nil, Unauthorized("请先登录")
	}
	film, err := s.repo.InteractiveFilm(userID, id)
	return film, filmError(err)
}
func (s *Service) SaveInteractiveFilm(userID, id string, req FilmDraftRequest) (*model.InteractiveFilm, error) {
	if userID == "" {
		return nil, Unauthorized("请先登录")
	}
	req.Title = strings.TrimSpace(req.Title)
	if req.Title == "" || utf8.RuneCountInString(req.Title) > 100 {
		return nil, BadAuthRequest("作品名称需为 1 至 100 字")
	}
	if utf8.RuneCountInString(req.Novel) > dramaMaxNovelRunes {
		return nil, BadAuthRequest("单部原著最多 600 万字")
	}
	if utf8.RuneCountInString(req.Direction) > 12000 {
		return nil, BadAuthRequest("改编方向最多 1.2 万字")
	}
	if len(req.Graph.Scenes) > 300 {
		return nil, BadAuthRequest("每部影游最多 300 场")
	}
	ids := map[string]bool{}
	for i, scene := range req.Graph.Scenes {
		if scene.Exits == nil {
			req.Graph.Scenes[i].Exits = []model.FilmExit{}
		}
		switch scene.Mode {
		case "choice", "next", "ending":
		default:
			return nil, BadAuthRequest("请选择有效的场次出口类型")
		}
		if !filmSceneID.MatchString(scene.ID) || ids[scene.ID] {
			return nil, BadAuthRequest("场次编号须为唯一的字母、数字、下划线或短横线，最多 64 位")
		}
		ids[scene.ID] = true
		if media := scene.Media; media != nil {
			if media.Kind != "event" && media.Kind != "clip" {
				return nil, BadAuthRequest("未知的节点类型")
			}
			if scene.Track != nil {
				return nil, BadAuthRequest("独立节点不能绑定场次互动轨")
			}
			if media.ResourceID != "" {
				resource, err := s.repo.ResourceForUser(userID, media.ResourceID)
				if errors.Is(err, gorm.ErrRecordNotFound) {
					return nil, BadAuthRequest("节点素材不可用")
				}
				if err != nil {
					return nil, err
				}
				if resource.Status != model.ResourceStatusReady || (media.Kind == "clip" && resource.Kind != "video") || (media.Kind == "event" && resource.Kind != "image") {
					return nil, BadAuthRequest("节点素材类型或状态不匹配")
				}
			}
		}
		if scene.Track != nil && len(scene.Track.Cues) > 64 {
			return nil, BadAuthRequest("每场最多 64 个互动点")
		}
		if scene.Track != nil && scene.Track.Cues == nil {
			scene.Track.Cues = []model.FilmCue{}
		}
		for _, exit := range scene.Exits {
			if p := exit.Spot; p != nil && (p.X < 0 || p.X > 100 || p.Y < 0 || p.Y > 100) {
				return nil, BadAuthRequest("点击位置应在画面内")
			}
			if utf8.RuneCountInString(exit.Feedback) > 500 {
				return nil, BadAuthRequest("点击反馈最多 500 字")
			}
			if utf8.RuneCountInString(exit.Item) > 60 || utf8.RuneCountInString(exit.RequiresItem) > 60 || len(exit.ID) > 128 {
				return nil, BadAuthRequest("携带物名称最多 60 字，出口编号最多 128 字节")
			}
		}
		if scene.Track != nil {
			for _, cue := range scene.Track.Cues {
				if utf8.RuneCountInString(cue.Question) > 80 || utf8.RuneCountInString(cue.CollectionName) > 60 {
					return nil, BadAuthRequest("选择点问题最多 80 字，线索名称最多 60 字")
				}
				if len(cue.ID) > 128 || utf8.RuneCountInString(cue.Label) > 60 || utf8.RuneCountInString(cue.Feedback) > 500 {
					return nil, BadAuthRequest("互动点编号或文案超过上限")
				}
			}
		}
		if utf8.RuneCountInString(scene.Script) > production.ScriptSourceChapterRunes || utf8.RuneCountInString(scene.Title) > 60 || len(scene.Exits) > 32 {
			return nil, BadAuthRequest("场次标题、正文或选项数量超过制作上限")
		}
	}
	film := &model.InteractiveFilm{ID: newID(), UserID: userID, Revision: 1, Takes: map[string]model.FilmTake{}}
	if id != "" {
		var err error
		film, err = s.InteractiveFilm(userID, id)
		if err != nil {
			return nil, err
		}
	}
	film.Title, film.Novel, film.Direction, film.Graph = req.Title, req.Novel, req.Direction, req.Graph
	if film.Graph.Scenes == nil {
		film.Graph.Scenes = []model.FilmScene{}
	}
	if id == "" {
		if req.CreationKey != "" {
			if !filmSceneID.MatchString(req.CreationKey) {
				return nil, BadAuthRequest("创建标识须为 1 至 64 位字母、数字、下划线或短横线")
			}
			film.ID = uuid.NewSHA1(uuid.NameSpaceURL, []byte("yingce/interactive-films/"+userID+"/"+req.CreationKey)).String()
			return s.repo.CreateInteractiveFilmOnce(film)
		}
		return film, s.repo.CreateInteractiveFilm(film)
	}
	return film, filmError(s.repo.UpdateInteractiveFilm(film, req.Revision))
}

// Prepare the shared drama only after an explicit handoff. Optimistic locking rolls back all
// episodes and their source chapters if the graph was edited or another handoff won the race.
func (s *Service) ProduceInteractiveFilm(userID, id string, req FilmProductionRequest) (*model.InteractiveFilm, error) {
	film, err := s.InteractiveFilm(userID, id)
	if err != nil {
		return nil, err
	}
	if req.Revision != film.Revision {
		return nil, filmError(repository.ErrFilmRevision)
	}
	if err := production.ValidateFilmGraph(film.Graph); err != nil {
		return nil, BadAuthRequest(err.Error())
	}
	wanted := map[string]bool{}
	for _, id := range req.SceneIDs {
		wanted[id] = true
	}
	if len(wanted) == 0 {
		return nil, BadAuthRequest("请选择要制作的场次")
	}
	if film.Takes == nil {
		film.Takes = map[string]model.FilmTake{}
	}
	var controller *model.DramaProduction
	if film.ProjectID != "" {
		_, err = s.repo.ProjectForUser(userID, film.ProjectID)
		if errors.Is(err, gorm.ErrRecordNotFound) {
			film.ProjectID = ""
			film.Takes = map[string]model.FilmTake{}
		} else if err != nil {
			return nil, err
		} else {
			controller, err = s.repo.DramaProduction(film.ProjectID)
			if err != nil {
				return nil, filmError(err)
			}
		}
	}
	var scenes []model.FilmScene
	for _, scene := range film.Graph.Scenes {
		if !wanted[scene.ID] {
			continue
		}
		delete(wanted, scene.ID)
		if scene.Media != nil {
			return nil, BadAuthRequest("互动事件和已有视频片段无需制作分镜")
		}
		if take, ok := film.Takes[scene.ID]; ok && take.Script == scene.Script {
			_, err := s.repo.DramaEpisode(film.ProjectID, take.EpisodeID)
			if err == nil {
				continue
			}
			if !errors.Is(err, gorm.ErrRecordNotFound) {
				return nil, err
			}
		}
		scenes = append(scenes, scene)
	}
	if len(wanted) > 0 {
		return nil, BadAuthRequest("投产包含不存在的场次")
	}
	if len(scenes) == 0 {
		return film, nil
	}
	var creation *dramaCreation
	if film.ProjectID == "" {
		chapters := make([]DramaChapterInput, 0, len(scenes))
		for _, scene := range scenes {
			chapters = append(chapters, DramaChapterInput{Title: scene.Title, Text: scene.Script})
		}
		name := truncateRunes(film.Title, 56) + " · 影游 " + film.ID[len(film.ID)-8:]
		creation, err = s.prepareDramaCreation(userID, newID(), CreateDramaRequest{Name: name, Chapters: chapters, Start: true, SourceFormat: model.DramaSourceScript, Settings: DramaSettings{Models: req.Models}})
		if err != nil {
			return nil, err
		}
		film.ProjectID = creation.project.ID
	}
	err = s.repo.Transaction(func(repo *repository.Repository) error {
		if creation != nil {
			if err := repo.CreateDramaProject(&creation.project, creation.chapters, &creation.production, creation.episodes...); err != nil {
				return err
			}
		}
		for i, scene := range scenes {
			var episodeID string
			if creation != nil {
				episodeID = creation.episodes[i].ID
			} else {
				now := time.Now()
				chapter := model.ProjectUnit{ID: newID(), ProjectID: film.ProjectID, Kind: model.ProjectUnitKindChapter, Title: scene.Title, SourceText: scene.Script, WordCount: utf8.RuneCountInString(scene.Script), Status: model.ProjectUnitStatusReady, CreatedAt: now, UpdatedAt: now}
				episode := newDramaChapterEpisode(film.ProjectID, 0, chapter, model.DramaSourceScript, now)
				if err := repo.AddDramaEpisodeSource(film.ProjectID, &chapter, &episode, nil); err != nil {
					return err
				}
				episodeID = episode.ID
			}
			film.Takes[scene.ID] = model.FilmTake{EpisodeID: episodeID, Script: scene.Script}
		}
		if controller != nil && controller.Status == model.DramaStatusCompleted {
			if err := repo.UpdateDramaProduction(film.ProjectID, map[string]any{"status": model.DramaStatusRunning, "stage": model.DramaStageProduce}); err != nil {
				return err
			}
		}
		return repo.UpdateInteractiveFilm(film, req.Revision)
	})
	if err != nil {
		return nil, filmError(err)
	}
	s.wakeDramaScheduler()
	return film, nil
}
