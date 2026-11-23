package model

import (
	"encoding/json"
	"time"
)

type FilmSetup struct {
	ManualGraph    bool            `json:"manualGraph,omitempty"`
	ChapterIndexes []int           `json:"chapterIndexes"`
	StyleID        string          `json:"styleId,omitempty"`
	Settings       json.RawMessage `json:"settings,omitempty"`
}

type FilmExit struct {
	Spot         *FilmSpot `json:"spot,omitempty"`
	Feedback     string    `json:"feedback,omitempty"`
	Label        string    `json:"label"`
	Target       string    `json:"target"`
	Item         string    `json:"item,omitempty"`
	RequiresItem string    `json:"requiresItem,omitempty"`
	ID           string    `json:"id,omitempty"`
}

type FilmSpot struct {
	Width      float64 `json:"width,omitempty"`
	Height     float64 `json:"height,omitempty"`
	Appearance string  `json:"appearance,omitempty"`
	ResourceID string  `json:"resourceId,omitempty"`
	X          float64 `json:"x"`
	Y          float64 `json:"y"`
}

type FilmNodeMedia struct {
	Presentation string `json:"presentation,omitempty"`
	AdvanceMs    int    `json:"advanceMs,omitempty"`
	Kind         string `json:"kind"`
	ResourceID   string `json:"resourceId,omitempty"`
}

type FilmCue struct {
	ID             string  `json:"id"`
	Kind           string  `json:"kind"`
	AtMs           int     `json:"atMs"`
	EndMs          int     `json:"endMs,omitempty"`
	X              float64 `json:"x,omitempty"`
	Y              float64 `json:"y,omitempty"`
	Label          string  `json:"label,omitempty"`
	Feedback       string  `json:"feedback,omitempty"`
	CollectionName string  `json:"collectionName,omitempty"`
	Question       string  `json:"question,omitempty"`
	Wait           bool    `json:"wait,omitempty"`
	Tail           bool    `json:"tail,omitempty"`
	TimeoutMs      int     `json:"timeoutMs,omitempty"`
	DefaultExit    string  `json:"defaultExit,omitempty"`
}

type FilmTrack struct {
	ResourceID string    `json:"resourceId"`
	DurationMs int       `json:"durationMs"`
	Cues       []FilmCue `json:"cues"`
}

type FilmScene struct {
	Media    *FilmNodeMedia `json:"media,omitempty"`
	ID       string         `json:"id"`
	Title    string         `json:"title"`
	Script   string         `json:"script"`
	Source   string         `json:"source"`
	Mode     string         `json:"mode"`
	Exits    []FilmExit     `json:"exits"`
	Track    *FilmTrack     `json:"track,omitempty"`
	Clue     string         `json:"clue,omitempty"`
	Response string         `json:"response,omitempty"`
}

type FilmGraph struct {
	Start  string      `json:"start"`
	Scenes []FilmScene `json:"scenes"`
}

type FilmTake struct {
	EpisodeID string `json:"episodeId"`
	Script    string `json:"script"`
}

type InteractiveFilm struct {
	Setup     *FilmSetup          `json:"setup,omitempty" gorm:"serializer:json;type:text"`
	ID        string              `json:"id" gorm:"primaryKey;size:36"`
	UserID    string              `json:"-" gorm:"index;size:36"`
	Title     string              `json:"title" gorm:"size:120"`
	Novel     string              `json:"novel" gorm:"type:text"`
	Direction string              `json:"direction" gorm:"type:text"`
	Graph     FilmGraph           `json:"graph" gorm:"serializer:json;type:text"`
	Revision  int64               `json:"revision"`
	ProjectID string              `json:"projectId" gorm:"size:36"`
	Takes     map[string]FilmTake `json:"takes" gorm:"serializer:json;type:text"`
	UpdatedAt time.Time           `json:"updatedAt"`
}
