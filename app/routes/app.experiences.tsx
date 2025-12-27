import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, useNavigate } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import type { HeadersFunction } from "react-router";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({
    where: { domain: session.shop },
    include: { experiences: true },
  });

  if (!shop) {
    return { experiences: [] };
  }

  return {
    experiences: shop.experiences.map((exp: any) => ({
      ...exp,
      includedCollections: JSON.parse(exp.includedCollections),
      excludedTags: JSON.parse(exp.excludedTags),
    })),
  };
};

export default function Experiences() {
  const { experiences } = useLoaderData<typeof loader>();
  const navigate = useNavigate();

  return (
    <s-page heading="Experiences">
      <s-button
        slot="primary-action"
        onClick={() => navigate("/app/experiences/new")}
      >
        Create experience
      </s-button>

      <s-section>
        {experiences.length === 0 ? (
          <s-paragraph>
            No experiences yet. Create your first experience to get started.
          </s-paragraph>
        ) : (
          <s-table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Mode</th>
                <th>Results</th>
                <th>Created</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {experiences.map((exp: any) => (
                <tr key={exp.id}>
                  <td>{exp.name}</td>
                  <td>{exp.mode}</td>
                  <td>{exp.resultCount}</td>
                  <td>{new Date(exp.createdAt).toLocaleDateString()}</td>
                  <td>
                    <s-button
                      variant="tertiary"
                      onClick={() => navigate(`/app/experiences/${exp.id}`)}
                    >
                      Edit
                    </s-button>
                  </td>
                </tr>
              ))}
            </tbody>
          </s-table>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

