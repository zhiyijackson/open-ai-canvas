// Package expandopenapi exposes a narrow, versioned facade over the host API.
//
// The package deliberately owns no authentication or business logic. Allowed
// requests are dispatched to the injected host handler after their path is
// rewritten from /api/expand-openapi/v1/... to the existing /api/... route.
package expandopenapi

import (
	"net/http"
	"path"
	"strings"

	"github.com/gin-gonic/gin"
)

const (
	ContractVersion  = "1.0.0"
	FacadeBasePath   = "/expand-openapi/v1"
	UpstreamBasePath = "/api"
)

type allowedRoute struct {
	method  string
	pattern string
}

var allowedRoutes = []allowedRoute{
	{http.MethodGet, "/auth/session"},
	{http.MethodGet, "/auth/profile"},
	{http.MethodGet, "/workbench/tools"},
	{http.MethodGet, "/workbench/tasks"},
	{http.MethodPost, "/workbench/tasks"},
	{http.MethodGet, "/tasks"},
	{http.MethodPost, "/tasks"},
	{http.MethodGet, "/tasks/:id"},
	{http.MethodPost, "/tasks/:id/cancel"},
	{http.MethodPost, "/tasks/:id/retry"},
	{http.MethodPost, "/tasks/:id/recover-media"},
	{http.MethodGet, "/resources"},
	{http.MethodPost, "/resources"},
	{http.MethodGet, "/resources/:id"},
	{http.MethodGet, "/resources/:id/file"},
	{http.MethodPost, "/resources/access"},
	{http.MethodPost, "/resources/uploads"},
	{http.MethodPut, "/resources/uploads/:id/chunks/:index"},
	{http.MethodPost, "/resources/uploads/:id/complete"},
	{http.MethodGet, "/assets"},
	{http.MethodPost, "/assets/batch"},
	{http.MethodPost, "/assets/batch-delete"},
	{http.MethodGet, "/assets/:id"},
	{http.MethodPut, "/assets/:id"},
	{http.MethodDelete, "/assets/:id"},
}

// Register mounts the facade below /expand-openapi/v1 on api. The upstream
// handler must serve the host's original /api routes. It may be the host's root
// router: rewritten requests cannot match this facade again.
func Register(api *gin.RouterGroup, upstream http.Handler, managers ...*Manager) {
	if api == nil {
		panic("expandopenapi: nil API router group")
	}
	if upstream == nil {
		panic("expandopenapi: nil upstream handler")
	}

	api.Any(FacadeBasePath+"/*proxyPath", func(c *gin.Context) {
		relativePath := c.Param("proxyPath")
		if relativePath == "/capabilities" {
			serveCapabilities(c)
			return
		}
		if relativePath == "/openapi.json" {
			serveOpenAPI(c)
			return
		}
		if !safeRelativePath(c.Request, relativePath) {
			writeFacadeError(c, http.StatusNotFound, "expand_openapi_path_not_allowed")
			return
		}

		pathAllowed, methodAllowed := routePermission(c.Request.Method, relativePath)
		if !pathAllowed {
			writeFacadeError(c, http.StatusNotFound, "expand_openapi_path_not_allowed")
			return
		}
		if !methodAllowed {
			writeFacadeError(c, http.StatusMethodNotAllowed, "expand_openapi_method_not_allowed")
			return
		}
		if len(managers) > 0 && managers[0] != nil && managers[0].handle(c, upstream, relativePath) {
			return
		}

		forwarded := c.Request.Clone(c.Request.Context())
		forwarded.URL.Path = UpstreamBasePath + relativePath
		forwarded.URL.RawPath = ""
		forwarded.RequestURI = forwarded.URL.Path
		if forwarded.URL.RawQuery != "" {
			forwarded.RequestURI += "?" + forwarded.URL.RawQuery
		}
		upstream.ServeHTTP(c.Writer, forwarded)
	})
}

// RegisterUnavailable keeps extension failure isolated from the host API while
// making the disabled state explicit to extension clients.
func RegisterUnavailable(api *gin.RouterGroup) {
	api.Any(FacadeBasePath+"/*proxyPath", func(c *gin.Context) {
		writeFacadeError(c, http.StatusServiceUnavailable, "expand_openapi_unavailable")
	})
}

func routePermission(method string, requestedPath string) (pathAllowed bool, methodAllowed bool) {
	for _, route := range allowedRoutes {
		if !matchPattern(route.pattern, requestedPath) {
			continue
		}
		pathAllowed = true
		if route.method == method {
			methodAllowed = true
		}
	}
	return pathAllowed, methodAllowed
}

func matchPattern(pattern string, requestedPath string) bool {
	patternParts := strings.Split(strings.TrimPrefix(pattern, "/"), "/")
	requestParts := strings.Split(strings.TrimPrefix(requestedPath, "/"), "/")
	if len(patternParts) != len(requestParts) {
		return false
	}
	for index, expected := range patternParts {
		actual := requestParts[index]
		if strings.HasPrefix(expected, ":") {
			if !safePathParameter(actual) || reservedPathParameter(pattern, index, actual) {
				return false
			}
			continue
		}
		if expected != actual {
			return false
		}
	}
	return true
}

func reservedPathParameter(pattern string, index int, value string) bool {
	if index != 1 {
		return false
	}
	reserved := map[string]map[string]bool{
		"resources": {"access": true, "import": true, "storage-usage": true, "uploads": true},
		"assets":    {"batch": true, "batch-delete": true, "folder": true},
	}
	root := strings.Split(strings.TrimPrefix(pattern, "/"), "/")[0]
	return reserved[root][value]
}

func safeRelativePath(request *http.Request, relativePath string) bool {
	if relativePath == "" || relativePath[0] != '/' || path.Clean(relativePath) != relativePath {
		return false
	}
	if strings.Contains(relativePath, "\\") || strings.Contains(relativePath, "//") {
		return false
	}
	escapedPath := strings.ToLower(request.URL.EscapedPath())
	return !strings.Contains(escapedPath, "%2f") &&
		!strings.Contains(escapedPath, "%5c") &&
		!strings.Contains(escapedPath, "%2e")
}

func safePathParameter(value string) bool {
	if value == "" || value == "." || value == ".." {
		return false
	}
	for _, char := range value {
		if (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') ||
			(char >= '0' && char <= '9') || char == '-' || char == '_' {
			continue
		}
		return false
	}
	return true
}

func writeFacadeError(c *gin.Context, status int, reason string) {
	c.AbortWithStatusJSON(status, gin.H{
		"code":   status,
		"data":   nil,
		"msg":    http.StatusText(status),
		"reason": reason,
	})
}
