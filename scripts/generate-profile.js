const fs = require("node:fs/promises");

const username =
  process.env.GITHUB_PROFILE_USERNAME ||
  process.env.GITHUB_REPOSITORY_OWNER ||
  "sidntrivedi";
const profileName = process.env.PROFILE_NAME || "Siddhant N Trivedi";
const token = process.env.GITHUB_TOKEN;
const apiBase = "https://api.github.com";
const days = Number(process.env.PROFILE_STATS_DAYS || 365);
const now = new Date();
const since = new Date(now);
since.setUTCDate(since.getUTCDate() - days);

const headers = {
  Accept: "application/vnd.github+json",
  "User-Agent": `${username}-profile-readme`,
  "X-GitHub-Api-Version": "2022-11-28",
};

if (token) {
  headers.Authorization = `Bearer ${token}`;
}

function compactNumber(value) {
  return new Intl.NumberFormat("en", { notation: "compact" }).format(value || 0);
}

function fullNumber(value) {
  return new Intl.NumberFormat("en").format(value || 0);
}

function yearsSince(dateString) {
  const created = new Date(dateString);
  const years = Math.max(0, now.getUTCFullYear() - created.getUTCFullYear());
  const hadAnniversary =
    now.getUTCMonth() > created.getUTCMonth() ||
    (now.getUTCMonth() === created.getUTCMonth() &&
      now.getUTCDate() >= created.getUTCDate());
  return hadAnniversary ? years : Math.max(0, years - 1);
}

function toApiUrl(path) {
  if (path.startsWith("http")) return path;
  return `${apiBase}${path}`;
}

function nextLink(linkHeader) {
  if (!linkHeader) return null;
  const next = linkHeader
    .split(",")
    .map((part) => part.trim())
    .find((part) => part.endsWith('rel="next"'));
  const match = next && next.match(/<([^>]+)>/);
  return match ? match[1] : null;
}

async function request(path, options = {}) {
  const response = await fetch(toApiUrl(path), {
    ...options,
    headers: {
      ...headers,
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${response.status} ${response.statusText}: ${body}`);
  }

  return {
    data: await response.json(),
    headers: response.headers,
  };
}

async function requestAll(path) {
  let url = path;
  const items = [];

  while (url) {
    const { data, headers: responseHeaders } = await request(url);
    items.push(...data);
    url = nextLink(responseHeaders.get("link"));
  }

  return items;
}

async function searchCount(query) {
  const params = new URLSearchParams({ q: query, per_page: "1" });
  const { data } = await request(`/search/issues?${params}`);
  return data.total_count || 0;
}

async function searchCommitSummary() {
  const params = new URLSearchParams({
    q: `author:${username} author-date:>=${since.toISOString().slice(0, 10)}`,
    per_page: "100",
    sort: "author-date",
    order: "desc",
  });
  const { data } = await request(`/search/commits?${params}`, {
    headers: {
      Accept: "application/vnd.github+json",
    },
  });

  const projects = new Map();
  for (const item of data.items || []) {
    const repo = item.repository;
    if (!repo) continue;

    const current = projects.get(repo.full_name) || {
      name: repo.name,
      url: repo.html_url,
      commits: 0,
    };
    current.commits += 1;
    projects.set(repo.full_name, current);
  }

  return {
    total: data.total_count || 0,
    projects: [...projects.values()]
      .sort((a, b) => b.commits - a.commits)
      .slice(0, 10),
  };
}

async function graphql(query, variables) {
  if (!token) return null;

  try {
    const { data } = await request("/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });

    if (data.errors) return null;
    return data.data;
  } catch {
    return null;
  }
}

async function contributionStats(userCreatedAt) {
  const from = since.toISOString();
  const to = now.toISOString();

  const data = await graphql(
    `
      query ProfileContributions($login: String!, $from: DateTime!, $to: DateTime!) {
        user(login: $login) {
          contributionsCollection(from: $from, to: $to) {
            totalCommitContributions
            totalIssueContributions
            totalPullRequestContributions
            totalPullRequestReviewContributions
            restrictedContributionsCount
            commitContributionsByRepository(maxRepositories: 10) {
              repository {
                name
                url
                description
              }
              contributions {
                totalCount
              }
            }
          }
        }
      }
    `,
    { login: username, from, to }
  );

  const collection = data?.user?.contributionsCollection;
  const commitSummary = collection ? null : await searchCommitSummary();
  const allTimeIssues = await searchCount(`author:${username} type:issue`);
  const allTimePullRequests = await searchCount(`author:${username} type:pr`);
  const lastYearCommits =
    collection?.totalCommitContributions ?? commitSummary?.total ?? 0;
  const lastYearIssues =
    collection?.totalIssueContributions ??
    (await searchCount(`author:${username} type:issue created:>=${since.toISOString().slice(0, 10)}`));
  const lastYearPullRequests =
    collection?.totalPullRequestContributions ??
    (await searchCount(`author:${username} type:pr created:>=${since.toISOString().slice(0, 10)}`));

  return {
    allTimeIssues,
    allTimePullRequests,
    lastYearCommits,
    lastYearIssues,
    lastYearPullRequests,
    lastYearReviews: collection?.totalPullRequestReviewContributions ?? 0,
    privateContributions: collection?.restrictedContributionsCount ?? 0,
    activeProjects:
      collection?.commitContributionsByRepository?.map((item) => ({
        name: item.repository.name,
        url: item.repository.url,
        commits: item.contributions.totalCount,
      })) ||
      commitSummary?.projects ||
      [],
    accountYears: yearsSince(userCreatedAt),
  };
}

async function languageStats(repos) {
  const fallback = () => primaryLanguageStats(repos);
  if (!token) return fallback();

  const totals = new Map();
  const visibleRepos = repos.filter((repo) => !repo.fork && !repo.archived);

  await Promise.all(
    visibleRepos.map(async (repo) => {
      try {
        const { data } = await request(`/repos/${repo.full_name}/languages`);
        for (const [language, bytes] of Object.entries(data)) {
          totals.set(language, (totals.get(language) || 0) + bytes);
        }
      } catch {
        // Ignore repositories whose language endpoint cannot be read.
      }
    })
  );

  const totalBytes = [...totals.values()].reduce((sum, value) => sum + value, 0);
  if (!totalBytes) return fallback();

  return [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([language, bytes]) => ({
      language,
      percent: totalBytes ? Math.round((bytes / totalBytes) * 1000) / 10 : 0,
    }));
}

function primaryLanguageStats(repos) {
  const totals = new Map();
  const visibleRepos = repos.filter(
    (repo) => !repo.fork && !repo.archived && repo.language
  );

  for (const repo of visibleRepos) {
    totals.set(repo.language, (totals.get(repo.language) || 0) + (repo.size || 1));
  }

  const totalSize = [...totals.values()].reduce((sum, value) => sum + value, 0);
  return [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([language, size]) => ({
      language,
      percent: totalSize ? Math.round((size / totalSize) * 1000) / 10 : 0,
    }));
}

function socialLinks(user) {
  const links = [
    `[GitHub](https://github.com/${username})`,
  ];

  if (user.blog) {
    const website = user.blog.startsWith("http") ? user.blog : `https://${user.blog}`;
    links.push(`[Website](${website})`);
  }

  if (user.twitter_username) {
    links.push(`[X](https://x.com/${user.twitter_username})`);
  }

  if (process.env.LINKEDIN_USERNAME) {
    links.push(`[LinkedIn](https://www.linkedin.com/in/${process.env.LINKEDIN_USERNAME})`);
  }

  if (process.env.EMAIL) {
    links.push(`[Email](mailto:${process.env.EMAIL})`);
  }

  return links.join(" | ");
}

function renderLanguageList(languages) {
  if (!languages.length) return "No public language data found yet.";
  return languages
    .map(({ language, percent }) => `**${language}** ${percent}%`)
    .join("<br>");
}

function renderProjects(projects, repos) {
  const fallback = repos
    .filter((repo) => !repo.fork)
    .sort((a, b) => b.stargazers_count - a.stargazers_count)
    .slice(0, 10)
    .map((repo) => ({
      name: repo.name,
      url: repo.html_url,
      stars: repo.stargazers_count,
      commits: null,
    }));

  const active = projects.length ? projects : fallback;
  if (!active.length) return "No public project activity found yet.";

  return active
    .map((project) => {
      const activity =
        project.commits === null
          ? ` - ${fullNumber(project.stars)} ${project.stars === 1 ? "star" : "stars"}`
          : ` - ${fullNumber(project.commits)} ${
              project.commits === 1 ? "commit" : "commits"
            }`;
      return `- [${project.name}](${project.url})${activity}`;
    })
    .join("\n");
}

function renderReadme({ user, repos, contributions, languages }) {
  const totalStars = repos.reduce((sum, repo) => sum + repo.stargazers_count, 0);
  const publicRepos = user.public_repos ?? repos.length;
  const joined = contributions.accountYears
    ? `Joined GitHub ${contributions.accountYears} years ago.`
    : `Joined GitHub on ${new Date(user.created_at).toLocaleDateString("en", {
        year: "numeric",
        month: "long",
        day: "numeric",
      })}.`;

  const lastYearPrivate =
    contributions.privateContributions > 0
      ? `<br>Private contributions: \`${fullNumber(contributions.privateContributions)}\``
      : "";
  const lastYearReviews =
    contributions.lastYearReviews > 0
      ? `<br>Reviews: \`${fullNumber(contributions.lastYearReviews)}\``
      : "";

  return `# Hi there, I'm ${profileName}

${joined}

${user.bio ? `${user.bio}\n` : ""}
## Stats

| All Time | Last Year | Top languages |
| --- | --- | --- |
| Public repos: \`${fullNumber(publicRepos)}\`<br>Stars earned: \`${compactNumber(totalStars)}\`<br>Issues opened: \`${fullNumber(contributions.allTimeIssues)}\`<br>Pull requests: \`${fullNumber(contributions.allTimePullRequests)}\` | Commits: \`${fullNumber(contributions.lastYearCommits)}\`<br>Issues opened: \`${fullNumber(contributions.lastYearIssues)}\`<br>Pull requests: \`${fullNumber(contributions.lastYearPullRequests)}\`${lastYearReviews}${lastYearPrivate} | ${renderLanguageList(languages)} |

## Most Active Projects (Last Year)

${renderProjects(contributions.activeProjects, repos)}

## Connect with me

${socialLinks(user)}

---

Last updated: ${now.toISOString().slice(0, 10)}
`;
}

async function main() {
  const [{ data: user }, repos] = await Promise.all([
    request(`/users/${username}`),
    requestAll(`/users/${username}/repos?per_page=100&type=owner&sort=updated`),
  ]);

  const [contributions, languages] = await Promise.all([
    contributionStats(user.created_at),
    languageStats(repos),
  ]);

  await fs.writeFile(
    "README.md",
    renderReadme({ user, repos, contributions, languages })
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
