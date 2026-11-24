package production

import (
	"fmt"
	"strings"
	"yingce/backend/internal/model"
)

// A valid reachable finite DAG with an explicit ending at every leaf always terminates.
func ValidateFilmGraph(graph model.FilmGraph) error {
	nodes := make(map[string]model.FilmScene, len(graph.Scenes))
	for _, scene := range graph.Scenes {
		if _, exists := nodes[scene.ID]; exists || strings.TrimSpace(scene.ID) == "" {
			return fmt.Errorf("场次编号为空或重复：%s", scene.ID)
		}
		nodes[scene.ID] = scene
	}
	if _, ok := nodes[graph.Start]; !ok {
		return fmt.Errorf("请选择有效的入口场次")
	}
	for _, s := range graph.Scenes {
		if strings.TrimSpace(s.Title) == "" || strings.TrimSpace(s.Script) == "" {
			return fmt.Errorf("场次 %s 缺少标题或剧本", s.ID)
		}
		switch s.Mode {
		case "ending":
			if len(s.Exits) != 0 {
				return fmt.Errorf("结局 %s 不能有出口", s.Title)
			}
		case "next":
			if len(s.Exits) != 1 {
				return fmt.Errorf("场次 %s 需要一个续播目标", s.Title)
			}
		case "choice":
			if len(s.Exits) < 2 {
				return fmt.Errorf("场次 %s 至少需要两个选择", s.Title)
			}
		default:
			return fmt.Errorf("场次 %s 的出口类型无效", s.Title)
		}
		for _, e := range s.Exits {
			if _, ok := nodes[e.Target]; !ok {
				return fmt.Errorf("场次 %s 的出口缺少有效目标", s.Title)
			}
			if s.Mode == "choice" && strings.TrimSpace(e.Label) == "" {
				return fmt.Errorf("场次 %s 的选项缺少文字", s.Title)
			}
		}
	}
	state := make(map[string]int)
	var visit func(string) error
	visit = func(id string) error {
		switch state[id] {
		case 1:
			return fmt.Errorf("剧情回环经过场次 %s", nodes[id].Title)
		case 2:
			return nil
		}
		state[id] = 1
		for _, edge := range nodes[id].Exits {
			if err := visit(edge.Target); err != nil {
				return err
			}
		}
		state[id] = 2
		return nil
	}
	if err := visit(graph.Start); err != nil {
		return err
	}
	for _, s := range graph.Scenes {
		if state[s.ID] == 0 {
			return fmt.Errorf("从入口无法到达场次 %s", s.Title)
		}
	}
	return validateFilmInteractions(graph, nodes)
}

func validateFilmInteractions(graph model.FilmGraph, nodes map[string]model.FilmScene) error {
	type clueSource struct{ scene, label string }
	clues := map[string]clueSource{}
	for _, scene := range graph.Scenes {
		exitIDs := map[string]bool{}
		for _, exit := range scene.Exits {
			if exit.ID == "" {
				continue
			}
			if exitIDs[exit.ID] {
				return fmt.Errorf("%s 的出口编号重复", scene.Title)
			}
			exitIDs[exit.ID] = true
		}
		track := scene.Track
		if track == nil {
			continue
		}
		lastEnd := -1
		cueIDs := map[string]bool{}
		for index, cue := range track.Cues {
			if cueIDs[cue.ID] || cue.ID == "" || cue.AtMs < 0 || cue.AtMs >= track.DurationMs || track.ResourceID == "" || cue.AtMs < lastEnd {
				return fmt.Errorf("%s 的互动点越界、重叠或缺少成片版本", scene.Title)
			}
			cueIDs[cue.ID] = true
			switch cue.Kind {
			case "caption":
				if cue.EndMs <= cue.AtMs || cue.EndMs > track.DurationMs || strings.TrimSpace(cue.Label) == "" || len([]rune(cue.Label)) > 500 {
					return fmt.Errorf("%s 的画内对白设置无效", scene.Title)
				}
				lastEnd = cue.EndMs
			case "hotspot":
				_, duplicate := clues[cue.ID]
				if cue.EndMs <= cue.AtMs || cue.EndMs > track.DurationMs || cue.X < 0 || cue.X > 100 || cue.Y < 0 || cue.Y > 100 || strings.TrimSpace(cue.Label) == "" || duplicate {
					return fmt.Errorf("%s 的热点设置无效", scene.Title)
				}
				label := cue.CollectionName
				if label == "" {
					label = cue.Label
				}
				clues[cue.ID] = clueSource{scene.ID, label}
				lastEnd = cue.EndMs
			case "choice":
				if scene.Mode != "choice" || index != len(track.Cues)-1 || cue.TimeoutMs < 0 || cue.TimeoutMs > 3600000 {
					return fmt.Errorf("%s 的分支点须位于最后且绑定本场选择", scene.Title)
				}
			default:
				return fmt.Errorf("%s 的互动类型无效", scene.Title)
			}
		}
	}
	type location struct{ scene, item string }
	seen := map[location]bool{}
	arrivals := map[string][]location{}
	next := map[location][]location{}
	queue := []location{{scene: graph.Start}}
	for len(queue) > 0 {
		current := queue[len(queue)-1]
		queue = queue[:len(queue)-1]
		if seen[current] {
			continue
		}
		seen[current] = true
		arrivals[current.scene] = append(arrivals[current.scene], current)
		scene := nodes[current.scene]
		if _, ok := clues[scene.Clue]; scene.Clue != "" && !ok {
			return fmt.Errorf("%s 引用了已移除的线索", scene.Title)
		}
		available := 0
		defaultOK := false
		var timed *model.FilmCue
		if scene.Track != nil && len(scene.Track.Cues) > 0 {
			last := &scene.Track.Cues[len(scene.Track.Cues)-1]
			if last.Kind == "choice" && last.TimeoutMs > 0 {
				timed = last
			}
		}
		for _, exit := range scene.Exits {
			if exit.RequiresItem != "" && exit.RequiresItem != current.item {
				continue
			}
			available++
			if timed != nil && exit.ID != "" && exit.ID == timed.DefaultExit {
				defaultOK = true
			}
			item := current.item
			if exit.Item != "" {
				item = exit.Item
			}
			target := location{exit.Target, item}
			next[current] = append(next[current], target)
			queue = append(queue, target)
		}
		if scene.Mode != "ending" && available == 0 {
			return fmt.Errorf("%s 在携带物「%s」下没有可用出口", scene.Title, current.item)
		}
		if timed != nil && !defaultOK {
			return fmt.Errorf("%s 的超时默认出口不可用", scene.Title)
		}
	}
	downstream := map[string]map[string]bool{}
	for _, scene := range graph.Scenes {
		if len(arrivals[scene.ID]) == 0 {
			return fmt.Errorf("%s 的携带条件使本场无法到达", scene.Title)
		}
		source, ok := clues[scene.Clue]
		if !ok || source.scene == scene.ID {
			continue
		}
		if downstream[source.scene] == nil {
			reached := map[string]bool{}
			visited := map[location]bool{}
			pending := append([]location(nil), arrivals[source.scene]...)
			for len(pending) > 0 {
				at := pending[len(pending)-1]
				pending = pending[:len(pending)-1]
				if visited[at] {
					continue
				}
				visited[at] = true
				reached[at.scene] = true
				pending = append(pending, next[at]...)
			}
			downstream[source.scene] = reached
		}
		if !downstream[source.scene][scene.ID] {
			return fmt.Errorf("%s 的观众无法在回应前取得线索「%s」", scene.Title, source.label)
		}
	}
	return nil
}
