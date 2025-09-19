const { DateTime } = require("luxon");
const { JSDOM } = require("jsdom");
const pluginRss = require("@11ty/eleventy-plugin-rss");
const markdownIt = require("markdown-it");
const markdownItFootnote = require("markdown-it-footnote");

module.exports = function (eleventyConfig) {
    eleventyConfig.addPassthroughCopy("src/styles.css");
    eleventyConfig.addPassthroughCopy("src/main.js");
    eleventyConfig.addPassthroughCopy("src/images");
    eleventyConfig.addPassthroughCopy("src/blog/**/*.{jpg,jpeg,png,gif,webp,svg}");

    eleventyConfig.addPlugin(pluginRss);

    // Configure markdown-it with footnotes
    const markdownLibrary = markdownIt({
        html: true,
        breaks: false,
        linkify: true
    }).use(markdownItFootnote);
    
    eleventyConfig.setLibrary("md", markdownLibrary);

    // Process Obsidian syntax before markdown parsing
    eleventyConfig.addPreprocessor("md", "obsidian", (data, content) => {
        return content.replace(/!\[\[([^|\]]+)(?:\|([^\]]+))?\]\]/g, (match, filename, caption) => {
            const altText = caption ? caption.trim() : filename.trim();
            return `![${altText}](${filename.trim()})`;
        });
    });

    eleventyConfig.addCollection("pages", function (collectionApi) {
        return collectionApi.getFilteredByGlob("src/sections/*.md").sort((a, b) => a.data.order - b.data.order);
    });

    eleventyConfig.addCollection("blog", function (collectionApi) {
        return collectionApi.getFilteredByGlob("src/blog/*.md").sort((a, b) => {
            return b.date - a.date;
        });
    });

    eleventyConfig.addFilter("date", (dateObj, format = "yyyy-MM-dd") => {
        return DateTime.fromJSDate(dateObj, { zone: "utc" }).toFormat(format);
    });

    eleventyConfig.addTransform("lazyloadImages", function (content, outputPath) {
        if (outputPath && outputPath.endsWith(".html")) {
            const dom = new JSDOM(content);
            const images = dom.window.document.querySelectorAll("img");

            images.forEach((img) => {
                if (!img.hasAttribute("loading")) {
                    img.setAttribute("loading", "lazy");
                }
            });

            return dom.serialize();
        }
        return content;
    });

    return {
        dir: {
            input: "src",
            includes: "_includes",
            output: "_site"
        },
        markdownTemplateEngine: "njk",
        htmlTemplateEngine: "njk",
        dataTemplateEngine: "njk",
        templateFormats: ["md", "njk"]
    };
};
