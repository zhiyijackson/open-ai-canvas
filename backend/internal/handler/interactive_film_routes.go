package handler

import (
	"github.com/gin-gonic/gin"
	"yingce/backend/internal/service"
)

func registerInteractiveFilmRoutes(r *gin.RouterGroup, svc *service.Service) {
	films := r.Group("/interactive-films")
	films.GET("/adaptation-method", dramaRoute(svc, 0, func(c *gin.Context, user string) (any, error) {
		method, err := svc.FilmAdaptationMethod()
		return gin.H{"method": method}, err
	}))
	films.GET("", dramaRoute(svc, 0, func(c *gin.Context, user string) (any, error) { return svc.ListInteractiveFilms(user) }))
	films.GET("/:id", dramaRoute(svc, 0, func(c *gin.Context, user string) (any, error) { return svc.InteractiveFilm(user, c.Param("id")) }))
	save := dramaRoute(svc, 64<<20, func(c *gin.Context, user string) (any, error) {
		var req service.FilmDraftRequest
		if err := bindDramaJSON(c, &req); err != nil {
			return nil, err
		}
		return svc.SaveInteractiveFilm(user, c.Param("id"), req)
	})
	films.POST("", save)
	films.PUT("/:id", save)
	films.POST("/:id/produce", dramaRoute(svc, 64<<10, func(c *gin.Context, user string) (any, error) {
		var req service.FilmProductionRequest
		if err := bindDramaJSON(c, &req); err != nil {
			return nil, err
		}
		return svc.ProduceInteractiveFilm(user, c.Param("id"), req)
	}))
}
