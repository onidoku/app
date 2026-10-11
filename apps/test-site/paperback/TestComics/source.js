"use strict";
// A Paperback 0.8 source for the test site, written by hand in the shape the Paperback toolchain
// (esbuild) emits: an IIFE assigned to `_Sources`, exported as `this.Sources`. Real bundles also
// carry cheerio; this one reads the test site's JSON API, so it needs nothing but `App`.
//
// Like real sources, it adds headers in its interceptor that a browser page can't set itself
// (referer, cookie), and the API refuses requests without them.
var _Sources = (() => {
  const SITE = "http://localhost:4173";

  class TestComics {
    constructor() {
      this.requestManager = App.createRequestManager({
        requestsPerSecond: 10,
        requestTimeout: 15000,
        interceptor: {
          interceptRequest: async (request) => {
            request.headers = {
              ...request.headers,
              "user-agent": await this.requestManager.getDefaultUserAgent(),
              "referer": `${SITE}/`,
              "x-test-source": "paperback",
            };
            request.cookies = [App.createCookie({ name: "pb-mature", value: "1", domain: SITE })];
            return request;
          },
          interceptResponse: async (response) => response,
        },
      });
      this.stateManager = App.createSourceStateManager();
    }

    async getMangaDetails(mangaId) {
      const data = await this.json(`/api/pb/manga/${encodeURIComponent(mangaId)}`);
      return App.createSourceManga({
        id: mangaId,
        mangaInfo: App.createMangaInfo({
          titles: [data.title],
          image: data.cover,
          author: data.authors.join(", "),
          desc: data.description,
          status: data.status,
          tags: [App.createTagSection({ id: "0", label: "genres", tags: data.genres.map((g) => App.createTag({ id: g, label: g })) })],
        }),
      });
    }

    async getChapters(mangaId) {
      const list = await this.json(`/api/pb/manga/${encodeURIComponent(mangaId)}/chapters`);
      // Newest first, numbered like Madara sources do: the highest sortingIndex is the newest.
      return list.map((c, i) => App.createChapter({ id: c.id, name: c.name, chapNum: c.number, sortingIndex: list.length - i }));
    }

    async getChapterDetails(mangaId, chapterId) {
      const data = await this.json(`/api/pb/chapter/${encodeURIComponent(mangaId)}/${encodeURIComponent(chapterId)}`);
      return App.createChapterDetails({ id: chapterId, mangaId, pages: data.pages });
    }

    async getSearchResults(query, metadata) {
      // A form POST, the way many sites search.
      const results = await this.json("/api/pb/search", { method: "POST", data: { q: encodeURIComponent(query.title ?? "") } });
      return App.createPagedResults({ results: results.map(tile), metadata });
    }

    async getHomePageSections(sectionCallback) {
      const sections = [
        App.createHomeSection({ id: "popular", title: "Popular", type: "singleRowNormal", containsMoreItems: true }),
        App.createHomeSection({ id: "featured", title: "Featured", type: "featured", containsMoreItems: false }),
      ];
      const paths = { popular: "/api/pb/popular?page=1&per=2", featured: "/api/pb/featured" };
      // Empty sections first, then filled in, as Paperback recommends.
      for (const section of sections) sectionCallback(section);
      await Promise.all(sections.map(async (section) => {
        section.items = (await this.json(paths[section.id])).map(tile);
        sectionCallback(section);
      }));
    }

    async getViewMoreItems(homepageSectionId, metadata) {
      if (homepageSectionId !== "popular") return App.createPagedResults({ results: [] });
      const page = metadata?.page ?? 1;
      const results = await this.json(`/api/pb/popular?page=${page}&per=2`);
      return App.createPagedResults({ results: results.map(tile), metadata: results.length ? { page: page + 1 } : undefined });
    }

    getMangaShareUrl(mangaId) {
      return `${SITE}/series/${mangaId}`;
    }

    async json(path, init = {}) {
      const request = App.createRequest({ url: `${SITE}${path}`, method: init.method ?? "GET", data: init.data });
      const response = await this.requestManager.schedule(request, 1);
      if (response.status === 403 || response.status === 503) {
        throw new Error(`CLOUDFLARE BYPASS ERROR:\nPlease go to the homepage of <${SITE}> and press the cloud icon.`);
      }
      if (response.status !== 200) throw new Error(`HTTP ${response.status} from ${path}`);
      return JSON.parse(response.data);
    }
  }

  function tile(s) {
    return App.createPartialSourceManga({ mangaId: s.id, title: s.title, image: s.cover });
  }

  const TestComicsInfo = {
    version: "1.0.0",
    name: "Test Comics (Paperback)",
    icon: "icon.svg",
    author: "onidoku tests",
    description: "Extension that pulls comics from the onidoku test site",
    contentRating: "EVERYONE",
    websiteBaseURL: SITE,
    sourceTags: [],
    intents: 5,
  };

  // A second source in the same repo, as repos built on one template (Madara, …) have many.
  class TestComicsLite extends TestComics {}
  const TestComicsLiteInfo = { ...TestComicsInfo, name: "Test Comics Lite (Paperback)" };

  return { TestComics, TestComicsInfo, TestComicsLite, TestComicsLiteInfo };
})();
this.Sources = _Sources; if (typeof exports === 'object' && typeof module !== 'undefined') {module.exports.Sources = this.Sources;}
