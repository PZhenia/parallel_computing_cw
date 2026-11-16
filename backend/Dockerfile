FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /app
COPY SearchServer.csproj .
RUN dotnet restore SearchServer.csproj
COPY . .
RUN dotnet publish SearchServer.csproj --configuration Release --output /app/publish --no-restore

FROM mcr.microsoft.com/dotnet/aspnet:10.0
WORKDIR /app
COPY --from=build /app/publish .
EXPOSE 8080
ENV ASPNETCORE_URLS=http://+:8080
ENTRYPOINT ["dotnet", "SearchServer.dll"]