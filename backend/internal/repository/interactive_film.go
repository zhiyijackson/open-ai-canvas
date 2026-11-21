package repository

import (
	"errors"

	"gorm.io/gorm/clause"
	"yingce/backend/internal/model"
)

var ErrFilmRevision = errors.New("interactive film revision changed")

func (r *Repository) ListInteractiveFilms(userID string) ([]model.InteractiveFilm, error) {
	rows := []model.InteractiveFilm{}
	err := r.db.Select("id", "title", "revision", "updated_at").Where("user_id = ?", userID).Order("updated_at desc, id").Find(&rows).Error
	return rows, err
}
func (r *Repository) InteractiveFilm(userID, id string) (*model.InteractiveFilm, error) {
	var film model.InteractiveFilm
	err := r.db.Where("id = ? AND user_id = ?", id, userID).First(&film).Error
	return &film, err
}
func (r *Repository) CreateInteractiveFilm(film *model.InteractiveFilm) error {
	return r.db.Create(film).Error
}

// The deterministic ID makes concurrent retries compete on the primary key.
func (r *Repository) CreateInteractiveFilmOnce(film *model.InteractiveFilm) (*model.InteractiveFilm, error) {
	result := r.db.Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "id"}}, DoNothing: true}).Create(film)
	if result.Error != nil || result.RowsAffected == 1 {
		return film, result.Error
	}
	return r.InteractiveFilm(film.UserID, film.ID)
}

// Both handoff and editor saves use the same compare-and-swap, including inside a transaction.
func (r *Repository) UpdateInteractiveFilm(film *model.InteractiveFilm, expected int64) error {
	film.Revision = expected + 1
	update := r.db.Model(film).Where("user_id = ? AND revision = ?", film.UserID, expected).
		Select("Title", "Novel", "Direction", "Graph", "ProjectID", "Takes", "Revision", "UpdatedAt").Updates(film)
	if update.Error != nil {
		return update.Error
	}
	if update.RowsAffected != 1 {
		return ErrFilmRevision
	}
	return nil
}
